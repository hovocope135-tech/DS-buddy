# DSH-projects

**Your next agent product may not need agents. Exploring the best way for people and AI to work together.**

[中文](README.md)

Do you keep switching between sessions, and does setting up each agent give you a headache? Do you wish you could keep a large number of agent conversations in hand without carrying context back and forth yourself?

If you are also looking for a better way to manage context, DSH-projects wants to offer the next way for people and AI to work together: hide every detail that isn't needed, let people focus on what really matters, and bring down the cost of working with AI.

This is the core philosophy DSH-projects is built on, and its main difference from similar agent products:

**1. Organise context around the nature of the task itself. Managing multiple agents is a false problem; the only thing that needs managing is context.**

- Only when a task by its nature needs splitting do we need multiple agents with different context. Otherwise multiple agents are a shallow imitation of a human meeting room. What really improves how well a task gets done is not shallow adversarial review, it is keeping the task's Goal document in good shape from the start.
- Multiple agents still have value, but we don't need the concept of an agent. In DSH-projects you can still open several sessions in parallel at the task level, but we don't put the agent concept forward. We think the only difference a user needs to perceive is the model.

**2. Take in as much context as possible, and free people from the chore of organising it.**

- DSH-projects builds on the open-source project screenpipe and can collect information from every channel on your machine, help you draft email replies, and think what you are thinking.
- Wherever you are, you don't carry context around and you don't worry about environments, files or opening new conversations. The personal assistant organises and assigns the context for you.

![Left: a common multi-agent product. Right: DSH-projects](docs/readme/arch-compare.png)

Left: a common multi-agent product, where context, Skills and runtime are bound into each agent. Right: DSH-projects, where one personal assistant serves many projects, each project is split into tasks along context boundaries, and the runtime is decoupled from the context and can be swapped per task. The numbers refer to the sections of the [architecture article](https://hovocope135-tech.github.io/DSH-projects/site/blog/en/deep/). The figure's labels are in Chinese.

If you want to try the next generation of AI too: your next agent product may not need agents.

**Install DSH-projects and try it.**

## Getting started

> The pictures and steps below show the interface in development: the pixel avatar, the card-style 待你决定 board, and asking with a screenshot. None of that is in this repository or on npm yet. What you install today, `preview.1`, is the previous version, so some screens differ.

The interface is in Chinese for now, so the names on screen are given in Chinese below.

This section walks you through it: install DSH-projects, make your own personal assistant, hand it a first job, and accept what comes back. About ten minutes. Before you start you need DeepSeek Harness (tested on 0.2.1; `npm install -g @deepseek-ai/dsh` if you don't have it), Node 24 or later, and an API key for your model.

### 1. Set up your assistant

The personal assistant is who you talk to in DSH-projects: you give it goals, and it brings back progress and the things that need your decision.

**Install.** One command adds the plugin, the next starts it:

```sh
dsh plugin --profile web add deepseek-harness-projects-plugin@preview
dsh --profile web        # start it and open the address it prints
```

<details>
<summary>Install from source</summary>

```sh
git clone https://github.com/hovocope135-tech/DSH-projects
cd DSH-projects/plugin
dsh plugin --profile web add "$(pwd)"    # add the plugin to DeepSeek Harness
dsh --profile web
```

</details>

Once it opens, **个人助理** (personal assistant) and **项目** (projects) appear on the left.

**Make your assistant.** The first time, a dialog titled **捏一个你的助理** (make your assistant) opens:

1. Under **形象** (look), pick one of six looks, then change **颜色** (colour), **身体** (body), **眼睛** (eyes) and **配饰** (accessory), and give it a name under **名字**. It is called Tacit by default.
2. Click **下一步** (next). Under **性格与呼出** (traits and shortcut), choose up to three traits, or describe it in one sentence. **呼出** is the shortcut that calls it up from anywhere, ⌥M by default.
3. Click **完成** (done). To do it later, click **跳过** (skip); everything can be changed under **形象与快捷键** in **助理设置** (assistant settings).

![First open: making your assistant. Pick a look, a colour and an accessory, then traits and the shortcut](docs/readme/first-run.gif)

This figure is its avatar from then on: in front of 个人助理 on the left, beside the conversation's title, and on the messages it brings to **待你决定** (waiting on you).

**Let it know more.** Optional; it works with nothing connected. All of these are turned on in **助理设置**, and all are read-only:

- **飞书实时读取** (Feishu, live): reads your Feishu messages and documents. It needs the Feishu command line, lark-cli, installed and signed in on this machine. After that you can ask "what did the design group just decide?", and when someone is waiting for your reply it shows up under 待你决定.
- **电脑文件** (computer files): reads the folders you name, or all files. After that you can say "find the job description on my computer and tell me what it asks for on motion".
- **活动与设备** (activity and devices): turns what you do on your computer into a timeline. See step 4.

### 2. Hand everything to your personal assistant

In DSH-projects we encourage you to bring every request straight to the personal assistant. Tell it what you need, and it turns your request into a project and creates that project by itself:

> We're hiring a front-end engineer who leans towards interaction and motion. Create a project 「前端招聘」 and start with two things: write a second-interview question set interview.md, three questions on motion and interaction details, each with scoring notes; then build a hiring page jobs.html that can go on the website.

![One sentence to the personal assistant: it creates the project, two tasks start at once, and the first delivery comes back for acceptance](docs/readme/assistant-flow.gif)

Say what to do and what counts as good. How to split it into tasks is its call. Where something is unclear, it asks you first.

After you send it, **前端招聘** appears under **项目** on the left, each of the two jobs becomes a task, and both start at once. You don't pick an agent, you don't open a new conversation, and you don't have to watch. When a task is done it shows up under **待你决定** on the right, for you to accept.

Beyond creating projects, you can say these to it directly:

- "Tell the interview-questions task to add one more question on CSS": passes a message to a task.
- "What is still waiting for me?": lists what waits for your acceptance or your decision.
- "Accept the interview questions for me": it first tells you what was delivered, and accepts once you confirm.

### 3. Manage tasks inside a project

Every project has several tasks. Open the project on the left, and **项目任务** (project tasks) on the right lists them with their states. Click a task, and the right side becomes its **任务详情** (task detail).

![Open a project and a task: the task detail holds the background, the output, the progress, the criteria, and which model the task uses](docs/readme/task-context.gif)

Each task has its own long-lived context.

- **背景** (background): what this job is, and your own words at the time.
- **产出** (output): the delivered files. Each revision adds a version.
- **读过的文件** (files read): what it read for this job.
- **进展** (progress): every step from opening the task to delivery; what you said along the way is recorded here too.
- **怎么算完成** (what counts as done): the criteria written down when work starts, checked one by one at delivery.
- **执行** (execution): which model this task uses. To change it, choose here.

This context keeps updating as the task moves, so whenever you open it you see the latest. If another model or executor takes over, it reads the same context.

**Accept, or ask for changes.** A finished task stops at **已交付，待验收** (delivered, waiting for acceptance). Open **交付** (delivery): pages, images and documents can be read right there.

- If it's fine, click **验收通过** (accept).
- To change something, click **请求修改** (request changes). The input box is filled with the file name; add what to change. What comes back is **第 2 版** (version 2), and your sentence is recorded under 进展.

![Asking for a change: one sentence, version 2 comes back within a minute, your sentence is in the progress list, then accept](docs/readme/revise-accept.gif)

### 4. Keep working: context keeps accumulating, and your assistant understands you better and better

**Computer History** (电脑活动记录) turns what you do on your computer into a timeline: one entry per 10 minutes, saying what you were doing and which apps you used.

![The timeline on the right: what you did on the computer, one entry per 10 minutes, filed under its project (demo data)](docs/readme/timeline.gif)

**Turn it on.** Computer History is off by default and needs Screenpipe on your machine:

1. Open **助理设置**, click **活动与设备**, then **设备与同步** (devices and sync).
2. Tick **同步此设备的观察资料** (sync this device's observations) and click **保存同步设置** (save sync settings).

After that, click + on the right and choose **时间线** (timeline): that is your record of today.

**Use it.** For a daily report, or to recall where something stands, you no longer rely on memory. Ask the personal assistant:

> 用一张可视化的图，展现我今天做了什么 (show me what I did today as a picture)

It first answers from the timeline in text. If you want the picture, reply 「做成一页网页」 (make it a web page): it hands today's data to a project, and a page you can open directly comes back.

![Asking for today as a picture: a text answer first, then the data goes to a project, and ten minutes later a visual page comes back (demo data)](docs/readme/ask-visual.gif)

The top of the timeline also has a few ready-made questions, such as 「今天做了哪些事，各到哪一步了？」 (what did I work on today, and where does each stand?). One click asks it.

It remembers your habits too. Say 「记住：我看东西习惯先看结论」 (remember: I read the conclusion first), and every conversation after that follows it. Everything it has remembered is under **记忆** (memory) in 助理设置, each with your own words, and you can edit or forget any of them.

### 5. Come back later

After you go offline, what you handed over keeps getting done. At night the personal assistant also goes over the day and picks out what is worth your attention. In the morning you don't scroll through conversations; **待你决定** is enough.

Before you go offline, tell Tacit what to do:

> I'm going offline and will check in the morning. Finish these three things overnight: an English version of the hiring page, jobs-en.html; a job description for the hiring site, jd.md; and a note on the interview process, process.md, saying what the first, second and final interviews each look at.

When you come back, open **待你决定** on the right:

- **项目进展** (project progress): one paragraph per active project, saying where it stands. Each row under it is one thing waiting for your acceptance or your decision; click a row to open that task.
- **新消息与建议** (messages and suggestions): what Tacit left for you overnight, three at most: one thing that could be done, one thing worth a look, one reminder. Click one and a sentence is written into the input box. Edit it, then send.

![Handing over three things before going offline; back on the board: where the project stands, what waits for acceptance, the suggestions left overnight; or just ask what happened overnight](docs/readme/night-and-morning.gif)

You can also just ask it 「夜里做了什么」 (what happened overnight). It gives the conclusion first, then the details.

At night it only reads: it sends no messages for you, changes no files and opens no tasks. Without a word from you it makes no decisions and accepts nothing.

### 6. Frame a piece of the screen and ask

You see something in another app and want to ask about it. No switching back, no copy and paste: frame that piece of the screen and ask the personal assistant. It knows your projects and tasks, and the answer comes with that context.

Say you are looking at a candidate's portfolio. Frame one of the works and ask:

> 按我们的二面题目，这位候选人该重点追问哪一题？ (going by our second-interview questions, which one should we press this candidate on?)

![Asking with a screenshot: press ⌥⇧M, frame a piece, type a sentence in the small window, and the answer appears there (composed demonstration)](docs/readme/shot-ask.gif)

**Turn it on.** Asking with a screenshot works on macOS for now, through a small Mac helper. The helper is not in this repository yet, so it cannot be installed today.

**Use it.**

1. In any app, press ⌥⇧M and drag over the piece you want to ask about.
2. A small window opens by the pointer with the capture in it. Type a sentence where it says 「问个人助理…」 and press Return.
3. The answer appears in the same window, and you can keep asking. Press esc, or ⌥⇧M again, to close it.

The same exchange also stays in the personal assistant's conversation, so you can continue on the page.

## Reference

**Models and executors.** Each project can have a one-sentence model strategy: write it yourself, or tell Tacit. Each task can switch its executor between DeepSeek Harness, Claude Code and Codex, and its model separately.

Claude Code and Codex run as executors without permission prompts or a sandbox: they can read and write whatever your OS user can.

**Every run is visible.** The developer view keeps every time the assistant was woken: what woke it, the steps in order, which step failed, and the result.

**What you can tell Tacit:**

| You say | What it does |
| --- | --- |
| "Make me a project: hiring a front-end engineer" | Creates a project |
| "Give this to the hiring project: …" | Hands your own words to the project as written, which opens a task |
| "What's waiting for me?" "What happened today?" | Answers from the board and the timeline, each item with its source |
| "Tell the interview-questions task to add a CSS question" | Passes the message to that task |
| "Accept it" | Tells you what changed first, and accepts after you reply "confirm" |
| "Remember: I like to read the conclusion first" | Adds it to About you, with your words |
| "Use a cheaper model for this project from now on" | Records it as the project's model strategy, then switches models accordingly |

It doesn't send messages in your name. Without a word from you it makes no decision and accepts nothing.

**When something goes wrong:**

| What you see | What to do |
| --- | --- |
| The page says it can't reach the service and is reconnecting | The service stopped or is restarting. The page reconnects by itself when it is back. |
| A task stopped at failed | Open the task and read the last progress entry. It is usually a model or network error; tell it to carry on. |
| Nothing happens after switching to Codex | Codex has to be logged in on this machine first. |

## More thinking

The steps above get you started. Why DSH-projects is built this way, how context is organised, assembled and collected, some early numbers and what is still unsolved are in a separate long piece: [Managing agents is managing context](https://hovocope135-tech.github.io/DSH-projects/site/blog/en/deep/).

- [Product page](https://hovocope135-tech.github.io/DSH-projects/site/), [film](https://github.com/hovocope135-tech/DSH-projects/releases/latest/download/tacit-film.mp4)
- [Getting started](docs/GETTING-STARTED.md), [features](docs/FEATURES.md) and [test report](docs/TESTING.md) (Chinese)

## Where it stands

Version 1.0. It runs only inside DeepSeek Harness, the interface is in Chinese for now, and Feishu is read-only. Claude Code as an executor has been run for real. Codex can be selected, but a complete task run on it has not been verified yet. Both run without permission prompts or a sandbox: they can read and write whatever your OS user can.

License: [MIT](LICENSE).
