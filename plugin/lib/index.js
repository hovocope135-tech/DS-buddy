/**
 * mira-projects: a Projects-style group chat for DSH.
 *
 * A project is a group chat with a coordinator, a few worker assistants and
 * Mira, a memory assistant. Every assistant runs in an ordinary DSH Session
 * keyed by (assistant, thread) and is woken by a Raft-style inbox notice;
 * threads carry Multica-style issue fields and appear in the chat as cards;
 * Mira watches the project, keeps its memory and hands the owner cards. The
 * browser half lives in `./client.js`; the two talk over exact routes on the
 * DSH `/api` channel, and `./dock.js` serves the floating window.
 */

import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { COORDINATOR, MIRA, ProjectStore } from './store.js'
import { Driver, defaultFolder } from './driver.js'
import { Actions, finalText, toolPaths } from './actions.js'
import { MiraService } from './mira.js'
import { createTools, visibleTo, maskPluginTools } from './tools.js'
import { registerRoutes } from './http.js'
import { HubActions, HubService, ensureHub, hubContinuity, hubLiveContext, hubRolePrompt, hubWakeText } from './hub.js'
import { AutoMemory } from './auto-memory.js'
import { ProjectIcons } from './project-icons.js'
import { AssistantLook } from './assistant-look.js'
import { Dream } from './dream.js'
import { NextSteps, NEXT_STEPS_EVERY_MINUTES } from './next-steps.js'
import { createHubTools, visibleToHub } from './hub-tools.js'
import { GitLabWorkflow } from './gitlab.js'
import { ProjectAutomations } from './automations.js'
import { FileBlobs, ProjectFiles } from './files.js'
import { ProjectRepositories } from './repositories.js'
import { ProjectDeviceBridge } from './devices.js'
import { DeviceDockerHost } from './runtime/device-host.js'
import { BlobMaintenance, liveBlobKeysFromStore } from './blob-maintenance.js'
import { PersonalMira, restrictPersonalAgent } from './personal.js'
import { SourceRetention } from './source-retention.js'
import { Observations } from './observations.js'
import { Connectors, loadConnectorConfig } from './connectors.js'
import { DeviceGateway, loadDeviceTokens } from './device-gateway.js'
import { ComputerHistory } from './computer-history.js'
import { Followups } from './followups.js'
import { FeishuAttention } from './attention.js'
import { FeishuLive } from './feishu-live.js'
import { MacFiles } from './mac-files.js'
import { Shots } from './shots.js'
import { BoardDigest } from './board-digest.js'
import { ExternalRuntime } from './external-runtime.js'

export const name = 'mira-projects'
export const inject = ['tools', 'agents', 'sessions', 'connection', 'systemPrompt']

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ dataDir?: string }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.runtime === 'container-node') return import('./runtime/node-plugin.js').then(module => module.applyContainerNode(ctx))
  if (config.runtime === 'postgres-lab') return import('./runtime/plugin.js').then(module => module.applyPostgresLab(ctx, config))
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const root = config.dataDir || join(home, 'mira-projects')
  const store = new ProjectStore(root, ctx.logger)
  store.load()
  const makeMessage = content => createUserMessage({ content, source: { kind: 'mira-projects' } })
  // Every plugin tool and who may see it. DSH's tools.register has no visibility option, so a project Session masks the
  // ones that are not its role's when it is set up (Mira's Session keeps her own allow-list).
  const pluginTools = []
  const driver = new Driver(ctx, store, makeMessage, { installModelSelection, toolPolicy: agent => {
    try { maskPluginTools(agent, pluginTools) } catch (error) { ctx.logger.warn(`mira-projects: could not hide other roles' tools from ${agent.id}`, error) }
  } })
  const blobs = new FileBlobs(join(root, '_files'), { quotaBytes: config.fileQuotaBytes })
  if (config.fileQuotaBytes !== undefined || config.fileGcIntervalMs !== undefined) {
    const maintenance = new BlobMaintenance(blobs, { liveKeys: () => liveBlobKeysFromStore(store, blobs), quotaBytes: config.fileQuotaBytes, retentionMs: config.fileRetentionMs })
    const timer = setInterval(() => maintenance.collect().catch(error => ctx.logger.warn('项目文件GC失败', error)), config.fileGcIntervalMs ?? 60 * 60 * 1000)
    timer.unref();ctx.effect(() => () => clearInterval(timer), 'mira-projects: file maintenance')
  }
  const files = new ProjectFiles(store, driver, { blobs, workspace: (project, key) => project.threads.get(key.slice(2))?.workspace?.cwd ?? project.cwd ?? defaultFolder(store, project) })
  const actions = new Actions(store, driver, { files })
  const repositories = new ProjectRepositories(files);driver.repositories = repositories
  let devices
  if (Array.isArray(config.deviceRoots) && config.deviceRoots.length) {
    if (!config.deviceStateRoot || !config.deviceImage) throw new Error('设备桥需要明确的私有状态目录和已验证镜像')
    const host = new DeviceDockerHost({ stateRoot: config.deviceStateRoot, image: config.deviceImage, roots: config.deviceRoots,
      deviceId: config.deviceId ?? 'dev_' + createHash('sha256').update(root).digest('hex').slice(0, 32),
      name: config.deviceName ?? '本机', onChange: () => store.touch() })
    devices = new ProjectDeviceBridge(store, driver, host);driver.devices = devices
  }
  const automations = new ProjectAutomations(ctx, store, driver);actions.automations = automations
  const gitlab = new GitLabWorkflow(store, actions, { logger: ctx.logger })
  // With the hub on, the morning recap is one across all projects instead of one per project.
  const mira = new MiraService(store, driver, actions, {}, { morning: config.hub === false })

  // The hub: Mira above all projects, in its own log beside the projects (see hub.js).
  let hub
  if (config.hub !== false) {
    const personalTools = new Set()
    const hubStore = new ProjectStore(join(root, '_hub'), ctx.logger)
    hubStore.load()
    ensureHub(hubStore)
    const retention = new SourceRetention(hubStore, store)
    const hubDriver = new Driver(ctx, hubStore, makeMessage, {
      // The personal assistant can be given its own model (hub_set_model, the 助理与模型 page) like any project assistant;
      // without this, a Session of an assistant with a model set cannot start (found 2026-11-18).
      installModelSelection,
      rolePrompt: project => hubRolePrompt(project),
      liveContext: hubLiveContext,
      wakeText: hubWakeText,
      continuityNotice: () => hubContinuity(),
      toolPolicy: agent => restrictPersonalAgent(agent, personalTools, join(home, 'attachments')),
      addressed: unread => unread.some(e => e.type === 'mira.requested' && e.reason === 'conversation'),
      unanswered: '用户在个人助理对话里提了问题。请先hub_inbox_read，再用hub_reply回答并带实际来源；没有资料要明确说明。不要把回复写成项目消息。',
      nudge: '<mira-wake reason="no_platform_call">\n上一轮你没有调用任何平台工具，用户什么也没看到。个人对话或重试请求用hub_reply回答原问题，事实带检索来源；写回顾用recap_write，递卡用hub_card_propose，记忆用hub_memory_write。没有个人问题且无需回顾才用hub_no_reply。\n</mira-wake>',
    })
    const hubActions = new HubActions(hubStore, hubDriver, store, actions)
    hub = { store: hubStore, driver: hubDriver, actions: hubActions, service: new HubService(hubStore, hubActions, store), retention }
    hub.observations = new Observations(hubStore, store, { root: join(root, '_observation-images'), quotaBytes: config.observationQuotaBytes, retention, notify: event => hubDriver.deliver(event, 'attention') })
    hub.connectors = new Connectors(hubStore, { configs: config.connectorConfigFile ? loadConnectorConfig(config.connectorConfigFile, { allowLoopback: config.connectorAllowLoopback === true }) : [], root: join(root, '_connector-state'), allowLoopback: config.connectorAllowLoopback === true, retention })
    ctx.effect(() => { hub.connectors.start();return () => hub.connectors.close() }, 'mira-projects: read-only connector polling')
    // v4: the owner's devices hand in Feishu, mail and screen observations here, on loopback only (devices reach it over
    // an SSH tunnel). Off unless a private device-token file is configured; collection itself stays off until the owner enables it.
    const deviceTokenFile = config.deviceTokenFile ?? process.env.MIRA_DEVICE_TOKEN_FILE
    if (deviceTokenFile) {
      // v4: the same entrance carries the assistant's read requests to the file reader on the owner's computer.
      hub.macFiles = new MacFiles({ hubStore })
      // 截图来问: the screenshot shortcut on the owner's computer hands its picture in through the same entrance; one side
      // call (defined below, called only later) picks the conversation it belongs to.
      hub.shots = new Shots({ hubStore, projects: store, root: join(root, '_shots'), logger: ctx.logger, complete: call => sideCall('mira-shot-match', 3000)(call), personal: () => hub.personal })
      const gateway = new DeviceGateway({ observations: hub.observations, files: hub.macFiles, shots: hub.shots, devices: loadDeviceTokens(deviceTokenFile), logger: ctx.logger })
      const port = Number(config.devicePort ?? process.env.MIRA_DEVICE_PORT ?? 18199)
      ctx.effect(() => {
        gateway.listen(port).then(bound => ctx.logger.info?.(`mira-projects: device entrance on 127.0.0.1:${bound}`), error => ctx.logger.warn('mira-projects: device entrance did not start', error))
        return () => { void gateway.close() }
      }, 'mira-projects: device entrance')
    }
    // Budgets leave room for models that think before they answer (KTH coding-model-1112 spent 600 tokens thinking on a
    // single pick, 2026-11-18): the reply comes after the thinking, inside the same max.
    // v4: one side call to DSH's default model (the way DSH titles sessions): no conversation, no tools, nothing the owner did
    // not already let the device send. The computer's history and the owed-reply check each make one per window or conversation.
    const sideCall = (kind, maxTokens = 4000) => async ({ system, input }) => {
      const llm = ctx.get('llm'), route = hubDriver.defaultModel()
      if (!llm || !route?.provider) throw new Error('DSH 默认模型尚未就绪')
      const signal = AbortSignal.timeout(120_000)
      const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens }, signal,
        (controls, model) => { const effort = model.reasoning?.efforts?.[0]?.id;return effort === undefined ? controls : { ...controls, reasoningEffort: effort } })
      const assembler = new BlockAssembler()
      const messages = [createUserMessage({ content: [{ type: 'text', text: input }], source: { kind } })]
      for await (const chunk of call.stream({ ...call.config, messages, system, signal })) assembler.push(chunk)
      if (['error', 'aborted'].includes(assembler.finish?.kind)) throw new Error(assembler.finish.failure?.message || '模型调用失败')
      return assembler.blocks().filter(b => b.type === 'text').map(b => b.text).join('')
    }
    hub.history = new ComputerHistory({ hubStore, observations: hub.observations, projects: store, logger: ctx.logger, complete: sideCall('mira-computer-history') })
    hub.followups = new Followups({ hubStore, logger: ctx.logger, complete: sideCall('mira-owed-replies') })
    hub.autoMemory = new AutoMemory({ hubStore, projects: store, hubActions, logger: ctx.logger, complete: sideCall('mira-auto-memory') })
    hub.projectIcons = new ProjectIcons({ store, logger: ctx.logger, complete: sideCall('mira-project-icon') })
    hub.look = new AssistantLook({ hubStore, complete: sideCall('mira-assistant-look') })
    // 做梦: one quiet session a night while the owner sleeps; it only reads and writes its own diary.
    hub.dream = new Dream({ hubStore, projects: store, look: hub.look, logger: ctx.logger, complete: sideCall('mira-dream', 8000) })
    // 巡看: in the day, about every half hour when something changed, one quiet look over everything; suggestions only.
    hub.nextSteps = new NextSteps({ hubStore, projects: store, logger: ctx.logger, complete: sideCall('mira-next-steps', 4000), muted: () => hub.dream.muted(),
      everyMs: Number(config.nextStepsMinutes ?? NEXT_STEPS_EVERY_MINUTES) * 60_000 })
    // 待你决定's project paragraphs: a short spoken summary per moving project, rewritten when that project changes.
    hub.boardDigest = new BoardDigest({ hubStore, projects: store, logger: ctx.logger, complete: sideCall('mira-board-digest', 6000) })
    hub.attention = new FeishuAttention({ hubStore, request: reason => hubActions.request(reason) })
    hub.feishuLive = new FeishuLive({ executable: config.feishuCliExecutable })
    ctx.effect(() => () => hub.feishuLive.stop(), 'mira-projects: feishu live')
    hub.personal = new PersonalMira(hubStore, hubDriver, store, actions, { observations: hub.observations, connectors: hub.connectors, retention, gitlab })
    ctx.effect(() => () => hub.personal.close(), 'mira-projects: personal search index')
    ctx.effect(() => () => retention.close(), 'mira-projects: source retention')
    ctx.effect(() => {
      const timer = setInterval(() => { try { retention.collect() } catch (error) { ctx.logger.warn('原文保留清理未完成', error) };hub.observations.summarize().catch(error => ctx.logger.warn('观察窗口摘要失败', error));hub.observations.retryImportant().catch(error => ctx.logger.warn('观察重要信号重试失败', error));hub.observations.maintenance.collect().catch(error => ctx.logger.warn('观察图片GC失败', error));hub.history.tick().catch(error => ctx.logger.warn('电脑历史整理失败', error));hub.followups.tick().then(() => hub.attention.tick()).catch(error => ctx.logger.warn('待回复检查失败', error));hub.autoMemory.tick().catch(error => ctx.logger.warn('记忆提炼失败', error));hub.projectIcons.tick().catch(error => ctx.logger.warn('项目图标没选出来', error));hub.dream.tick();hub.nextSteps.tick();hub.boardDigest.tick().catch(error => ctx.logger.warn('看板段落没写成', error)) }, 60_000)
      timer.unref()
      return () => { clearInterval(timer);hub.observations.close() }
    }, 'mira-projects: observation maintenance')
    for (const { definition } of createHubTools({ defineTool, hubStore, hubDriver, hubActions, projects: store, projectDriver: driver, personal: hub.personal, feishuLive: hub.feishuLive, macFiles: hub.macFiles })) {
      personalTools.add(definition.name)
      pluginTools.push({ name: definition.name, visible: visibleToHub(hubStore) })
      ctx.effect(() => ctx.tools.register(definition), `mira-projects: hub tool ${definition.name}`)
    }
  }

  const projectTools = createTools({ defineTool, store, driver, actions, files, devices })
  const external = new ExternalRuntime(ctx, store, driver, actions, projectTools, {
    root: join(root, '_external-runtime'), executables: config.externalRuntimeExecutables, profiles: config.externalRuntimeProfiles,
  })
  driver.external = external
  for (const { role, definition } of projectTools) {
    pluginTools.push({ name: definition.name, visible: visibleTo(store, role) })
    ctx.effect(() => ctx.tools.register(definition), `mira-projects: tool ${definition.name}`)
  }

  // A resumed project Session gets its role prompt back before its first step.
  ctx.on('agent/created', ({ agent }) => {
    automations.registerCourier(agent)
    driver.registerScoped(agent)
    hub?.driver.registerScoped(agent)
  })

  // v4 harness (E2E #12): Sessions whose typed words were just passed on to the task's current executor (see below).
  const passedOn = new WeakMap()
  ctx.on('agent/pre-step', (payload, next) => {
    const at = passedOn.get(payload.agent)
    if (at === undefined) return next()
    passedOn.delete(payload.agent)
    return Date.now() - at < 10_000 ? Promise.resolve({ kind: 'reject' }) : next()
  }, { prepend: true })

  // v4: a task opens as its own DSH Session, so the owner types straight into it. Those words reach the worker as an
  // ordinary turn; the thread also records them as the owner's own words (acceptance checks the owner's original text).
  // Only messages the web composer stamped as the user's count; the driver's wakes carry `mira-projects`.
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (message?.source?.kind !== 'user') return
    const body = (Array.isArray(message.content) ? message.content : []).filter(part => part?.type === 'text').map(part => part.text).join('\n').trim()
    if (!body) return
    // Mira's own Session is her conversation with the owner.
    if (hub?.store.bySession(agent.id)?.key === MIRA) {
      try { hub.personal.mirrorNative({ text: body }) } catch (error) { ctx.logger.warn('mira-projects: recording a message to Mira failed', error) }
      return
    }
    // v4 harness (E2E #12): after a task changes executor its old DSH Session can still be on the owner's screen. What is
    // typed there goes to whoever runs the task now, and the old Session does not run it: two executors never work one task.
    try {
      if (actions.redirectTyped({ sessionId: agent.id, text: body })) {
        // The wake that comes with the words would open a turn with nothing in it, and the model would answer the silence.
        // That one turn is refused. A turn already running is left to finish: executors change only between turns.
        if (agent.status !== 'running') passedOn.set(agent, Date.now())
        agent.inbox.remove(message.id)
        return
      }
    } catch (error) { ctx.logger.warn('mira-projects: passing typed words to the task\'s executor failed', error) }
    const binding = store.bySession(agent.id)
    if (binding === undefined || !(binding.key.startsWith('w:') || binding.key === COORDINATOR)) return
    // The project conversation is the project assistant's own Session; a task is its executor's.
    try {
      if (binding.key === COORDINATOR) actions.mirrorNativeChat({ projectId: binding.projectId, text: body })
      else actions.mirrorNativeMessage({ projectId: binding.projectId, threadId: binding.key.slice(2), text: body })
    } catch (error) { ctx.logger.warn('mira-projects: recording a typed message failed', error) }
  })

  // v4: the project conversation is the project assistant's own Session, so the text that ends its turn is what the owner
  // reads. The project chat records it (memory and search see it) and a woken turn answered this way needs no nudge.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    // A task's own session: the files its tools read become the task board's 输入.
    const task = store.bySession(session?.id)
    if (task?.key?.startsWith('w:')) {
      const paths = toolPaths(event.data?.message)
      if (paths.length) try { actions.noteInputs({ projectId: task.projectId, threadId: task.key.slice(2), paths }) } catch (error) { ctx.logger.warn('mira-projects: recording a task\'s inputs failed', error) }
    }
    // Mira's answer to words typed in her Session. Her woken turns answer through hub_reply and end in tools, so a text there is not recorded.
    if (hub?.store.bySession(session?.id)?.key === MIRA) {
      const said = finalText(event.data?.message)
      if (!said || hub.driver.turnOf(session.id) !== undefined) return
      try { hub.personal.mirrorReply({ text: said }) } catch (error) { ctx.logger.warn('mira-projects: recording a Mira reply failed', error) }
      return
    }
    const binding = store.bySession(session?.id)
    if (binding?.key !== COORDINATOR) return
    const said = finalText(event.data?.message)
    if (!said) return
    driver.replied(session.id)
    try { actions.mirrorAssistantText({ projectId: binding.projectId, text: said }) } catch (error) { ctx.logger.warn('mira-projects: recording a project-conversation reply failed', error) }
  })

  ctx.inject(['sessionController'], (webCtx) => {
    webCtx.effect(() => {
      driver.setController(webCtx.sessionController)
      automations.reconcile().catch(() => {})
      hub?.driver.setController(webCtx.sessionController)
      return () => {
        driver.setController(undefined)
        hub?.driver.setController(undefined)
      }
    }, 'mira-projects: session controller')
  })

  ctx.inject(['schedule'], (scheduleCtx) => {
    scheduleCtx.effect(() => {
      automations.native = scheduleCtx.schedule
      automations.reconcile().catch(() => {})
      return () => { automations.native = null }
    }, 'mira-projects: native schedule')
  })

  ctx.effect(() => registerRoutes(ctx, { store, driver, actions, mira, hub, gitlab, automations, files, repositories, devices }), 'mira-projects: routes')
  ctx.effect(() => automations.start(), 'mira-projects: automation bridge')
  ctx.effect(() => gitlab.start(), 'mira-projects: GitLab workflow')
  ctx.effect(() => mira.start(), 'mira-projects: mira')
  if (hub !== undefined) ctx.effect(() => hub.service.start(), 'mira-projects: hub')
  ctx.effect(() => async () => { driver.stop(); hub?.driver.stop();await external.stop();await devices?.host.close() }, 'mira-projects: driver')
}
