"""Build the Tacit launch post as a plain static site: public/index.html (中文), public/en/index.html (English),
public/style.css, public/img/. Content lives in content/zh.md and content/en.md; diagrams are drawn here.
Usage: python3 build.py   (run from this folder)"""
import html, re, shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "public"

# ---------------------------------------------------------------- diagrams
L = {
 "zh": dict(you="你", board="看板 / 群聊", assign="派活、追进度", pm="产品经理", des="设计师", eng="工程师", own="自己的上下文",
            talk="互相发消息、转述，上下文一人一份", lead="总指挥", ask="一个问题", worker="分身", clean="干净的上下文",
            back="互相不说话，只把结论交回去", task="同一个任务", ma="模型 A", mb="模型 B", mc="模型 C", merge="汇总，或者你来挑",
            chat="聊天软件", mail="邮件、日历", files="文件、应用", comein="消息和文件自己进来", asst="常驻助理", mem="记忆文件",
            wake="定时自己醒来", qa="一问一答", src="来源", gate="把关", triage="研判", ticket="工单", run="执行",
            panel="面板：只列需要人的事", state="状态", result="结果", onlythis="只看这一块",
            say="你说的话", screen="屏幕", feishu="飞书", local="电脑里的文件", ctx="上下文层", log="事件日志", tl="时间线",
            memory="记忆", pt="项目 → 任务", t="任务", fork="fork", inbox="待你决定", needs="该你了才找你",
            wb="拍板、验收、要改，都记回去", r1="结果", r2="回到", r3="一处",
            z1="只有 brief", z2="过滤或压缩后的历史", z3="完整历史", loc="（本地）", rem="（远程 A2A）", dflt="（默认）", tacitrow="DS-buddy：任务说明 + 你的原话 + 项目文件",
            p1="要做什么", p2="上下文在哪", p3="标准是什么", ptitle="任务的上下文包", pr1="目标和背景", pr2="你的原话", pr3="怎么算完成", pr4="进展和产出", pr5="读过的文件",
            prt="执行的 runtime（一次性）", pin="开工时注入", pout="进展写回", pkeep="长期维护", pswap="随时可以换",
            xtitle="一个执行会话的上下文，从前往后", xstable="稳定的前缀：每次唤醒都能命中缓存", xappend="每次唤醒只在末尾追加",
            xsys="系统提示", xrole="角色说明（开会话时冻结）", xturns="之前的回合", xwake="唤醒通知", xpull="拉取的条目", xgrow="新内容从这里往后加",
            xsame="同一件事 → 续接同一个会话", xnew="项目设置变了 → 开新会话，重新冻结",
            hscreen="屏幕：每分钟", hfeishu="飞书：每 2 分钟", hraw="原始记录", hwin="每 10 分钟一窗", hmodel="小模型：0 到 3 件事",
            hwith="带上一段活动和项目列表", hcheck="代码核对出处", hdrop="指不回原始记录的丢弃", htl="时间线", hread="个人助理读取"),
 "en": dict(you="You", board="Board / group chat", assign="assign, chase progress", pm="PM", des="Designer", eng="Engineer", own="its own context",
            talk="They message and relay to each other; one context each", lead="Orchestrator", ask="one question", worker="Worker", clean="clean context",
            back="No cross-talk; only conclusions come back", task="The same task", ma="Model A", mb="Model B", mc="Model C", merge="Merge, or you pick",
            chat="Chat apps", mail="Mail, calendar", files="Files, apps", comein="messages and files come in", asst="Assistant", mem="memory files",
            wake="wakes on a timer", qa="ask and answer", src="Source", gate="Gate", triage="Triage", ticket="Ticket", run="Run",
            panel="Panel: only what needs a person", state="state", result="result", onlythis="looks here only",
            say="What you say", screen="Screen", feishu="Feishu", local="Files on your Mac", ctx="Context layer", log="Event log", tl="Timeline",
            memory="Memory", pt="Project → task", t="Task", fork="fork", inbox="Waiting on you", needs="when it needs you",
            wb="every click is written back", r1="results", r2="come", r3="back",
            z1="Brief only", z2="Filtered or compressed history", z3="Full history", loc=" (local)", rem=" (remote A2A)", dflt=" (default)", tacitrow="DS-buddy: task brief + your own words + project files",
            p1="What to do", p2="Where context is", p3="The standard", ptitle="The task's context pack", pr1="Goal and background", pr2="Your own words", pr3="What counts as done", pr4="Progress and outputs", pr5="Files read",
            prt="Runtimes (disposable)", pin="injected at start", pout="progress written back", pkeep="maintained over time", pswap="swappable any time",
            xtitle="One executor session's context, start to end", xstable="Stable prefix: a cache hit on every wake", xappend="Each wake appends at the end only",
            xsys="System prompt", xrole="Role, frozen at start", xturns="Earlier turns", xwake="Wake notice", xpull="Pulled items", xgrow="New content goes on from here",
            xsame="Same job → same session", xnew="Settings changed → new session",
            hscreen="Screen: every minute", hfeishu="Feishu: every 2 min", hraw="Raw records", hwin="10-minute window", hmodel="Small model, 0–3 items",
            hwith="plus last activity, projects", hcheck="Code checks sources", hdrop="unsourced: dropped", htl="Timeline", hread="Assistant reads it"),
}

def box(cx, cy, w, h, text, cls="n", bold=False):
    t = f'<text class="d-t{" d-b" if bold else ""}" x="{cx}" y="{cy + 4.5}" text-anchor="middle">{html.escape(text)}</text>' if text else ""
    return f'<rect class="d-{cls}" x="{cx - w / 2}" y="{cy - h / 2}" width="{w}" height="{h}" rx="6"/>' + t
def txt(x, y, text, anchor="middle", cls="d-m"): return f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}">{html.escape(text)}</text>'
def line(d): return f'<path class="d-e" d="{d}"/>'
def arrow(d, mid, both=False, dashed=False):
    return f'<path class="d-e{" d-dash" if dashed else ""}" d="{d}" marker-end="url(#{mid})"' + (f' marker-start="url(#{mid}s)"' if both else "") + "/>"
def bus(px, py, mid, xs, top, m): return line(f"M{px} {py} V{mid}") + line(f"M{min(xs)} {mid} H{max(xs)}") + "".join(arrow(f"M{x} {mid} V{top}", m) for x in xs)
def svg(name, h, body, label):
    m = f"ar-{name}"
    defs = (f'<defs><marker id="{m}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="d-h" d="M0 0L10 5L0 10z"/></marker>'
            f'<marker id="{m}s" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path class="d-h" d="M10 0L0 5L10 10z"/></marker></defs>')
    return f'<svg viewBox="0 0 680 {h}" role="img" aria-label="{html.escape(label, quote=True)}">{defs}{body}</svg>'

def fig_roles(t, cap):
    m = "ar-roles"; b = box(340, 22, 64, 30, t["you"], "you") + arrow("M340 37 V62", m) + txt(352, 54, t["assign"], "start")
    b += box(340, 80, 280, 34, t["board"]) + bus(340, 97, 118, [130, 340, 550], 137, m)
    for x, name in ((130, t["pm"]), (340, t["des"]), (550, t["eng"])):
        b += box(x, 178, 180, 80, "") + txt(x, 163, name, cls="d-t d-b") + box(x, 195, 130, 26, t["own"], "ctx")
    b += arrow("M222 178 H248", m, both=True, dashed=True) + arrow("M432 178 H458", m, both=True, dashed=True) + txt(340, 246, t["talk"])
    return svg("roles", 258, b, cap)
def fig_orchestrator(t, cap):
    m = "ar-orchestrator"; xs = [100, 260, 420, 580]
    b = box(340, 22, 64, 30, t["you"], "you") + arrow("M340 37 V60", m) + txt(352, 53, t["ask"], "start") + box(340, 78, 160, 34, t["lead"]) + bus(340, 95, 116, xs, 135, m)
    for x in xs: b += box(x, 170, 140, 68, "") + txt(x, 157, t["worker"], cls="d-t d-b") + box(x, 185, 112, 24, t["clean"], "ctx")
    return svg("orchestrator", 246, b + txt(340, 232, t["back"]), cap)
def fig_parallel(t, cap):
    m = "ar-parallel"; xs = [150, 340, 530]
    b = box(340, 22, 64, 30, t["you"], "you") + arrow("M340 37 V60", m) + box(340, 78, 200, 34, t["task"], "ctx") + bus(340, 95, 114, xs, 131, m)
    for x, name in zip(xs, (t["ma"], t["mb"], t["mc"])): b += box(x, 149, 150, 34, name) + line(f"M{x} 166 V188")
    b += line("M150 188 H530") + arrow("M340 188 V208", m) + box(340, 226, 240, 34, t["merge"])
    return svg("parallel", 250, b, cap)
def fig_assistant(t, cap):
    m = "ar-assistant"; b = ""
    for y, name in ((50, t["chat"]), (110, t["mail"]), (170, t["files"])): b += box(100, y, 150, 32, name) + line(f"M175 {y} H215")
    b += line("M215 50 V170") + arrow("M215 110 H255", m) + txt(222, 28, t["comein"], "start")
    b += box(362, 110, 210, 136, "") + txt(362, 80, t["asst"], cls="d-t d-b") + box(362, 112, 150, 28, t["mem"], "ctx") + txt(362, 154, t["wake"])
    b += arrow("M470 110 H565", m, both=True) + txt(517, 100, t["qa"]) + box(600, 110, 64, 30, t["you"], "you")
    return svg("assistant", 200, b, cap)
def fig_panel(t, cap):
    m = "ar-panel"; xs = [68, 204, 340, 476, 612]; names = (t["src"], t["gate"], t["triage"], t["ticket"], t["run"]); b = ""
    for i, (x, name) in enumerate(zip(xs, names)):
        b += box(x, 40, 104, 34, name, "ctx" if i == 3 else "n")
        if i < 4: b += arrow(f"M{x + 52} 40 H{xs[i + 1] - 54}", m)
    b += box(340, 130, 380, 38, t["panel"]) + arrow("M476 57 V109", m) + txt(484, 88, t["state"], "start")
    b += arrow("M612 57 V130 H532", m) + txt(620, 100, t["result"], "start")
    b += box(340, 206, 64, 30, t["you"], "you") + arrow("M340 191 V151", m) + txt(352, 176, t["onlythis"], "start")
    return svg("panel", 230, b, cap)
def fig_tacit(t, cap):
    m = "ar-tacit"; b = ""
    for y, name in ((58, t["say"]), (100, t["screen"]), (142, t["feishu"]), (184, t["local"])): b += box(85, y, 130, 30, name) + line(f"M150 {y} H170")
    b += line("M170 58 V184") + arrow("M170 121 H198", m)
    b += box(305, 121, 210, 182, "", "ctx") + txt(305, 56, t["ctx"], cls="d-t d-b")
    for y, name in ((86, t["log"]), (120, t["tl"]), (154, t["memory"]), (188, t["pt"])): b += box(305, y, 170, 28, name)
    for y in (58, 121, 184): b += arrow(f"M410 {y} H458", m) + box(520, y, 120, 30, t["t"]) + line(f"M580 {y} H606")
    b += txt(434, 46, t["fork"], cls="d-a") + line("M606 58 V270") + arrow("M606 270 H597", m)
    for k, w in enumerate((t["r1"], t["r2"], t["r3"])): b += txt(614, 222 + 16 * k, w, "start")
    b += box(520, 270, 150, 34, t["inbox"]) + arrow("M445 270 H339", m) + txt(392, 260, t["needs"]) + box(305, 270, 64, 30, t["you"], "you")
    b += arrow("M305 255 V214", m) + txt(296, 240, t["wb"], "end")
    return svg("tacit", 300, b, cap)
def fig_inherit(t, cap):
    m = "ar-inherit"; cols = {120: ["Claude Code subagent" + t["dflt"], "Kimi CLI", "Gemini CLI" + t["loc"], "Codex spawn_agent", "DeepAgents task", "CrewAI"],
                              340: ["Gemini CLI" + t["rem"], "OpenAI nest_handoff_history", "Codex fork", "DeepAgents fork"],
                              560: ["Claude Code fork", "OpenAI Agents SDK handoff", "LangGraph Supervisor", "AutoGen GroupChat"]}
    b = arrow("M24 34 H656", m) + line("M230 46 V238").replace('class="d-e"', 'class="d-e d-dash"') + line("M450 46 V238").replace('class="d-e"', 'class="d-e d-dash"')
    for x, name in ((120, t["z1"]), (340, t["z2"]), (560, t["z3"])): b += txt(x, 22, name, cls="d-t d-b")
    for x, names in cols.items():
        for k, name in enumerate(names): b += box(x, 66 + 30 * k, 196, 24, name)
    b += box(230, 262, 330, 28, t["tacitrow"], "ctx")
    return svg("inherit", 286, b, cap)
def fig_pack(t, cap):
    m = "ar-pack"; b = box(80, 30, 64, 30, t["you"], "you") + line("M80 45 V57")
    for y, name in ((72, t["p1"]), (125, t["p2"]), (178, t["p3"])): b += box(80, y, 130, 30, name) + line(f"M145 {y} H160")
    b += line("M160 72 V178") + arrow("M160 125 H183", m)
    b += box(285, 125, 200, 206, "", "ctx") + txt(285, 46, t["ptitle"], cls="d-t d-b")
    for k, name in enumerate((t["pr1"], t["pr2"], t["pr3"], t["pr4"], t["pr5"])): b += box(285, 74 + 31 * k, 168, 25, name)
    b += '<rect class="d-g" x="520" y="44" width="148" height="162" rx="6"/>' + txt(594, 34, t["prt"])
    for y, name in ((80, "DeepSeek Harness"), (125, "Claude Code"), (170, "Codex")): b += box(594, y, 124, 28, name)
    b += arrow("M386 104 H518", m) + txt(452, 96, t["pin"]) + arrow("M518 150 H388", m) + txt(452, 166, t["pout"])
    b += txt(285, 248, t["pkeep"], cls="d-a") + txt(594, 226, t["pswap"])
    return svg("pack", 258, b, cap)
def fig_prefix(t, cap):
    m = "ar-prefix"; b = txt(22, 20, t["xtitle"], "start", cls="d-t d-b")
    b += line("M22 46 H436") + line("M22 46 V54") + line("M436 46 V54") + txt(229, 40, t["xstable"], cls="d-a")
    b += line("M446 46 H658") + line("M446 46 V54") + line("M658 46 V54") + txt(552, 40, t["xappend"])
    for cx, w, name, cls in ((78, 112, t["xsys"], "n"), (222, 168, t["xrole"], "ctx"), (372, 128, t["xturns"], "n"), (495, 98, t["xwake"], "n"), (604, 108, t["xpull"], "n")):
        b += box(cx, 78, w, 36, name, cls)
    b += arrow("M446 112 H664", m) + txt(552, 130, t["xgrow"])
    b += box(170, 172, 280, 32, t["xsame"]) + box(500, 172, 300, 32, t["xnew"])
    return svg("prefix", 200, b, cap)
def fig_history(t, cap):
    m = "ar-history"; b = box(80, 44, 140, 30, t["hscreen"]) + box(80, 92, 140, 30, t["hfeishu"])
    b += line("M150 44 H168") + line("M150 92 H168") + line("M168 44 V92") + arrow("M168 68 H186", m)
    b += box(258, 68, 140, 34, t["hraw"], "ctx") + arrow("M328 68 H350", m) + box(420, 68, 136, 34, t["hwin"])
    b += arrow("M488 68 H508", m) + box(590, 68, 160, 34, t["hmodel"]) + txt(590, 38, t["hwith"])
    b += arrow("M590 85 V139", m) + box(590, 158, 160, 34, t["hcheck"]) + txt(590, 192, t["hdrop"])
    b += arrow("M510 158 H490", m) + box(420, 158, 136, 34, t["htl"], "ctx") + arrow("M352 158 H330", m) + box(258, 158, 140, 34, t["hread"])
    return svg("history", 206, b, cap)
FIGS = dict(prefix=fig_prefix, history=fig_history, inherit=fig_inherit, pack=fig_pack, roles=fig_roles, orchestrator=fig_orchestrator, parallel=fig_parallel, assistant=fig_assistant, panel=fig_panel, tacit=fig_tacit)

# ---------------------------------------------------------------- tiny markdown
BULLET = re.compile(r"^(- |\d+\. )")
def inline(s):
    s = html.escape(s, quote=False)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", s)
    return re.sub(r"\[([^\]]+)\]\(([^)\s]+)\)", r'<a href="\2">\1</a>', s)
def convert(md, lang, rel=""):
    blocks = [b.strip("\n") for b in re.split(r"\n\s*\n", md.strip())]
    out, toc, title, dek, n2, n3, kicker = [], [], "", "", 0, 0, ""
    for b in blocks:
        lines = b.split("\n"); first = lines[0]
        if first.startswith("^ "):
            kicker = first[2:].strip(); lines = lines[1:]
            if not lines: continue
            first = lines[0]
        if first.startswith("# "):
            title = first[2:].strip()
            if len(lines) > 1 and lines[1].startswith("> "): dek = lines[1][2:].strip()
        elif first.startswith("> "): dek = first[2:].strip()
        elif first.startswith("## "):
            n2 += 1; n3 = 0; hid = f"s{n2}"; toc.append((2, hid, first[3:].strip())); out.append(f'<h2 id="{hid}">{inline(first[3:].strip())}</h2>')
        elif first.startswith("### "):
            n3 += 1; hid = f"s{n2}-{n3}"; toc.append((3, hid, first[4:].strip())); out.append(f'<h3 id="{hid}">{inline(first[4:].strip())}</h3>')
        elif first.startswith("```"):
            code = "\n".join(l for l in lines[1:] if not l.startswith("```"))
            out.append(f'<pre><code>{html.escape(code, quote=False)}</code></pre>')
        elif first.startswith("{{fig:"):
            name, cap = first[6:-2].split("|", 1)
            out.append(f'<figure class="dia">{FIGS[name](L[lang], cap)}<figcaption>{inline(cap)}</figcaption></figure>')
        elif first.startswith("!["):
            m = re.match(r'!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)', first)
            cap = f"<figcaption>{inline(m.group(3))}</figcaption>" if m.group(3) else ""
            src = m.group(2) if "://" in m.group(2) else rel + m.group(2)
            out.append(f'<figure class="shot"><a href="{src}"><img src="{src}" alt="{html.escape(m.group(1), quote=True)}" loading="lazy"></a>{cap}</figure>')
        elif first.startswith("|"):
            rows = [[c.strip() for c in l.strip().strip("|").split("|")] for l in lines if not re.match(r"^\|\s*-", l)]
            head = "".join(f"<th>{inline(c)}</th>" for c in rows[0])
            body = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in rows[1:])
            out.append(f'<div class="tw"><table><thead><tr>{head}</tr></thead><tbody>{body}</tbody></table></div>')
        elif re.match(r"^(- |\d+\. )", first):
            tag = "ul" if first.startswith("- ") else "ol"
            items = "".join("<li>" + inline(BULLET.sub("", l)) + "</li>" for l in lines)
            out.append(f"<{tag}>{items}</{tag}>")
        else:
            text = " ".join(lines)
            cls = ' class="lab"' if re.match(r"^(做法|观点|代表|How (they|it) works?|My view|Our view|Examples?)[:：]", text) else ""
            text = re.sub(r"^(做法|观点|代表|How (?:they|it) works?|My view|Our view|Examples?)([:：])", r"<b>\1</b>\2", inline(text)) if cls else inline(text)
            out.append(f"<p{cls}>{text}</p>")
    return title, dek, "\n".join(out), toc, kicker

# ---------------------------------------------------------------- page
UI = {"zh": dict(lang="zh-CN", post="介绍", deep="工程架构", guide="使用说明", toc="目录", date="2026/11/16", theme="切换深浅色", by="DS-buddy"),
      "en": dict(lang="en", post="Introduction", deep="Architecture", guide="Guide", toc="On this page", date="16 Nov 2026", theme="Toggle theme", by="DS-buddy")}
SITE = "https://hovocope135-tech.github.io/DS-buddy/site/blog/"   # where the pages are served; change it if the repository is renamed
MARK = '<svg class="mark" viewBox="0 0 30 30" aria-hidden="true"><path d="M5 5h20v6h-7v14h-6V11H5z"/></svg>'
def page(lang, title, dek, body, toc, rel, sub, kicker="", desc=""):
    """rel: path from this page back to the site root; sub: "" for the launch post, "deep/" for the teardown."""
    u = UI[lang]; here = lambda path: path or "./"
    base = rel + ("en/" if lang == "en" else "")                     # this language's home
    zh_href, en_href = here(rel + sub), rel + "en/" + sub
    url = SITE + ("en/" if lang == "en" else "") + sub
    share = "".join(f'<meta property="og:{k}" content="{html.escape(v, quote=True)}">\n' for k, v in (("type", "article"), ("site_name", "DS-buddy"), ("title", title), ("description", desc), ("url", url)))
    if lang == "zh": share += f'<meta property="og:image" content="{SITE}img/rd2-hero.jpg">\n<meta name="twitter:card" content="summary_large_image">\n'   # the picture carries Chinese text
    else: share += '<meta name="twitter:card" content="summary">\n'
    ON = ' class="on"'
    nav = "".join("<a" + (ON if sub == s2 else "") + ' href="' + here(base + s2) + '">' + label + "</a>" for s2, label in (("", u["post"]), ("deep/", u["deep"]), ("guide/", u["guide"])))
    toc_html = "".join(f'<a class="l{lv}" href="#{hid}">{html.escape(t)}</a>' for lv, hid, t in toc)
    aside = f'<aside class="toc" aria-label="{u["toc"]}"><div>{toc_html}</div></aside>' if toc else ""
    return f"""<!doctype html>
<html lang="{u["lang"]}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)} | DS-buddy</title>
<meta name="description" content="{html.escape(desc, quote=True)}">
{share}<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;450;500;600&family=IBM+Plex+Mono:wght@400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="{rel}style.css">
<script>try{{var t=localStorage.getItem("tacit-theme");if(t)document.documentElement.setAttribute("data-theme",t)}}catch(e){{}}</script>
</head>
<body>
<div class="page{"" if toc else " notoc"}">
<aside class="side">
  <a class="brand" href="{here(base)}"><span>DS-buddy</span></a>
  <nav>{nav}<a href="https://github.com/hovocope135-tech/DS-buddy">GitHub</a></nav>
</aside>
<main>
  <div class="bar">
    <a class="brand sm" href="{here(base)}"><span>DS-buddy</span></a>
    <span class="sp"></span>
    <button class="theme" type="button" aria-label="{u["theme"]}" title="{u["theme"]}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg></button>
    <span class="langs"><a href="{zh_href}"{' class="on" aria-current="page"' if lang == "zh" else ""} lang="zh-CN">中文</a><i>/</i><a href="{en_href}"{' class="on" aria-current="page"' if lang == "en" else ""} lang="en">EN</a></span>
  </div>
  <article>
    <header>
      {f'<p class="kick">{inline(kicker)}</p>' if kicker else ""}
      <h1>{inline(title)}</h1>
      <p class="meta">{u["by"]} <i>·</i> {u["date"]}</p>
      {f'<p class="dek">{inline(dek)}</p>' if dek else ""}
    </header>
{body}
  </article>
</main>
{aside}
</div>
<script>
document.querySelector(".theme").addEventListener("click",function(){{var r=document.documentElement,d=r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"),n=d==="dark"?"light":"dark";r.setAttribute("data-theme",n);try{{localStorage.setItem("tacit-theme",n)}}catch(e){{}}}});
</script>
</body>
</html>
"""

CSS = r''':root{--bg:#fcfcfc;--fg:#202020;--p:#5c5c5c;--muted:#8d8d8d;--line:#e4e4e4;--card:#ffffff;--soft:#f3f3f3;
  --accent:#2f5bd8;--accent-soft:#e9efff;--you:#a8741a;--you-soft:#fcf1d6;--edge:#9b9b9b;
  --sans:"IBM Plex Sans","PingFang SC","Noto Sans CJK SC","Microsoft YaHei",system-ui,sans-serif;--mono:"IBM Plex Mono",ui-monospace,Menlo,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#111111;--fg:#ededed;--p:#b2b2b2;--muted:#7c7c7c;--line:#2b2b2b;--card:#181818;--soft:#1c1c1c;
  --accent:#8fa8ff;--accent-soft:#1b2542;--you:#e2b55a;--you-soft:#3a2e10;--edge:#707070;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#111111;--fg:#ededed;--p:#b2b2b2;--muted:#7c7c7c;--line:#2b2b2b;--card:#181818;--soft:#1c1c1c;
  --accent:#8fa8ff;--accent-soft:#1b2542;--you:#e2b55a;--you-soft:#3a2e10;--edge:#707070;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:17px;line-height:1.62;letter-spacing:-.012em;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:underline;text-decoration-color:var(--muted);text-underline-offset:3px;text-decoration-thickness:1px}
a:hover{text-decoration-color:var(--fg)}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.page{display:grid;grid-template-columns:minmax(0,1fr);max-width:720px;margin:0 auto;padding:0 20px 96px}
.side,.toc{display:none}
.brand{display:inline-flex;align-items:center;gap:9px;text-decoration:none;font-weight:500;font-size:16px}
.mark{width:18px;height:18px;fill:var(--fg)}
.bar{display:flex;align-items:center;gap:14px;height:56px;border-bottom:.5px solid var(--line);margin-bottom:36px;font-size:14.5px}
.bar .sp{flex:1}
.theme{appearance:none;border:0;background:none;color:var(--fg);padding:6px;margin:-6px;cursor:pointer;display:grid;place-items:center}
.theme svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round}
.langs a{text-decoration:none;color:var(--muted)}
.langs a.on{color:var(--fg);font-weight:500}
.langs i{font-style:normal;color:var(--muted);margin:0 7px}
article header{margin-bottom:34px}
.kick{font-size:14px;color:var(--muted);margin:0 0 10px}
h1{font-size:30px;line-height:1.3;font-weight:500;letter-spacing:-.02em;margin:0 0 12px;text-wrap:balance}
.meta{font-size:14.5px;color:var(--muted);margin:0 0 16px}
.meta i{font-style:normal;margin:0 4px}
.dek{color:var(--p);margin:0;font-size:17px}
h2{font-size:23px;line-height:1.4;font-weight:500;letter-spacing:-.018em;margin:56px 0 14px;scroll-margin-top:20px}
h3{font-size:19px;line-height:1.45;font-weight:500;letter-spacing:-.015em;margin:38px 0 10px;scroll-margin-top:20px}
p{color:var(--p);margin:0 0 16px}
p.lab{margin-bottom:8px}
p.lab b{color:var(--fg);font-weight:500}
strong{color:var(--fg);font-weight:500}
ul,ol{color:var(--p);margin:0 0 18px;padding-left:1.35em}
li{margin:5px 0;padding-left:.15em}
li::marker{color:var(--muted)}
pre{font-family:var(--mono);font-size:13.5px;line-height:1.6;background:var(--soft);border-radius:8px;padding:14px 16px;margin:0 0 22px;overflow-x:auto;color:var(--fg)}
pre code{background:none;padding:0;font-size:inherit;border-radius:0}
code{font-family:var(--mono);font-size:.86em;background:var(--soft);padding:.12em .38em;border-radius:4px;color:var(--fg)}
figure{margin:26px 0 28px}
figure.shot a{display:block}
figure.shot img{display:block;width:100%;height:auto;border:.5px solid var(--line);border-radius:6px;background:var(--card)}
figure.dia{border:.5px solid var(--line);border-radius:6px;background:var(--card);padding:22px 18px 16px;overflow-x:auto}
figure.dia svg{display:block;width:100%;min-width:560px;height:auto}
figcaption{font-size:14px;line-height:1.55;color:var(--muted);margin-top:10px}
figure.dia figcaption{margin-top:14px;padding-top:12px;border-top:.5px solid var(--line)}
.tw{overflow-x:auto;margin:22px 0 24px}
table{border-collapse:collapse;width:100%;min-width:620px;font-size:15px;line-height:1.5}
th,td{text-align:left;vertical-align:top;padding:8px 14px 8px 0;border-bottom:.5px solid var(--line)}
th{font-weight:500;color:var(--fg);border-bottom-color:var(--muted)}
td{color:var(--p)}
td:first-child{color:var(--fg);white-space:nowrap}
tbody tr:last-child td{border-bottom:0}
.d-n{fill:var(--card);stroke:var(--edge);stroke-width:1}
.d-ctx{fill:var(--accent-soft);stroke:var(--accent);stroke-width:1}
.d-you{fill:var(--you-soft);stroke:var(--you);stroke-width:1}
.d-e{fill:none;stroke:var(--edge);stroke-width:1.2}
.d-dash{stroke-dasharray:4 4}
.d-g{fill:none;stroke:var(--edge);stroke-width:1;stroke-dasharray:5 4}
.d-h{fill:var(--edge)}
svg text{font-family:var(--sans);letter-spacing:0}
.d-t{fill:var(--fg);font-size:13px}
.d-b{font-weight:500}
.d-m{fill:var(--muted);font-size:12px}
.d-a{fill:var(--accent);font-size:12px;font-weight:500}
@media (min-width:1120px){
  .page{grid-template-columns:190px 680px 220px;column-gap:56px;max-width:none;width:max-content;padding:0 28px 120px}
  .side{display:block;position:sticky;top:0;align-self:start;padding-top:18px;height:100vh}
  .side nav{display:flex;flex-direction:column;gap:8px;margin-top:26px;font-size:15px}
  .side nav a{text-decoration:none;color:var(--muted)}
  .side nav a.on,.side nav a:hover{color:var(--fg)}
  .page.notoc{grid-template-columns:190px 680px}
  .bar .brand.sm{display:none}
  .toc{display:block;position:sticky;top:0;align-self:start;height:100vh;overflow-y:auto;padding:92px 0 40px;font-size:13.5px;line-height:1.45}
  .toc a{display:block;text-decoration:none;color:var(--muted);padding:4px 0}
  .toc a:hover{color:var(--fg)}
  .toc a.l2{color:var(--p);margin-top:8px}
  .toc a.l3{padding-left:14px}
}
@media (max-width:560px){body{font-size:16px}h1{font-size:25px}h2{font-size:21px}h3{font-size:18px}.page{padding:0 16px 72px}}
@media print{.side,.toc,.bar{display:none}}
'''

PAGES = [("zh", "zh.md", "", "", ""), ("zh", "zh-deep.md", "deep/", "../", "deep/"), ("zh", "zh-guide.md", "guide/", "../", "guide/"),
         ("en", "en-guide.md", "en/guide/", "../../", "guide/"),
         ("en", "en.md", "en/", "../", ""), ("en", "en-deep.md", "en/deep/", "../../", "deep/")]
def main():
    if OUT.exists(): shutil.rmtree(OUT)
    (OUT / "img").mkdir(parents=True)
    used = {"rd2-hero.jpg"}   # the share image of the Chinese pages
    for src in (ROOT / "content").glob("*.md"): used |= set(re.findall(r"img/([\w.-]+\.jpg)", src.read_text(encoding="utf-8")))
    for name in sorted(used): shutil.copy2(ROOT / "img" / name, OUT / "img" / name)   # only the images the pages use
    (OUT / "style.css").write_text(CSS, encoding="utf-8")
    for lang, src, outdir, rel, sub in PAGES:
        title, dek, body, toc, kicker = convert((ROOT / "content" / src).read_text(encoding="utf-8"), lang, rel)
        dest = OUT / outdir / "index.html"; dest.parent.mkdir(parents=True, exist_ok=True)
        first = re.search(r"<p>(.*?)</p>", body, re.S)
        first = html.unescape(re.sub(r"<[^>]+>", "", first.group(1))).strip() if first else ""
        cut = 110 if lang == "zh" else 220
        desc = dek or (first if len(first) <= cut else first[:cut].rstrip() + "…")
        dest.write_text(page(lang, title, dek, body, toc, rel, sub, kicker, desc), encoding="utf-8")
        text = re.sub(r"<[^>]+>", "", re.sub(r"<svg.*?</svg>", "", body, flags=re.S))
        print(dest.relative_to(ROOT), "| chars", len(re.sub(r"\s+", "", text)), "| headings", len(toc), "| figures", body.count("<figure"))
if __name__ == "__main__": main()
