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

> The pictures show the interface in development (pixel avatar, card-style 待你决定 board, asking with a screenshot). That code is not in this repository or on npm yet; what you install today, `preview.1`, is the previous version.

You need DeepSeek Harness (tested on 0.2.1; `npm install -g @deepseek-ai/dsh` if you don't have it), Node 24 or later, and an API key for your model. The interface is in Chinese for now, so the names on screen are given in Chinese.

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

How to turn each thing on and how to use it is in the [guide](docs/GETTING-STARTED.en.md).

### 1. Set up your assistant

On first open, a dialog titled **捏一个你的助理** (make your assistant) lets you pick a look and traits, give it a name, and choose a shortcut that calls it up. It is called Tacit by default. To let it know more, connect Feishu or your computer's files, or turn on Computer History, under **助理设置** (assistant settings). All of it is optional and read-only.

![First open: making your assistant](docs/readme/first-run.gif)

### 2. Hand everything to your personal assistant

In DSH-projects we encourage you to bring every request straight to the personal assistant. Tell it what you need, and it turns your request into a project and creates that project by itself:

> We're hiring a front-end engineer who leans towards interaction and motion. Create a project 「前端招聘」 and start with two things: write a second-interview question set interview.md, three questions on motion and interaction details, each with scoring notes; then build a hiring page jobs.html that can go on the website.

![One sentence to the personal assistant: it creates the project, two tasks start at once, and the first delivery comes back for acceptance](docs/readme/assistant-flow.gif)

Say what to do and what counts as good; how to split it into tasks is its call. You don't pick an agent, you don't open a new conversation, and you don't have to watch: a finished task shows up under **待你决定** (waiting on you) on the right, for you to accept.

### 3. Manage tasks inside a project

Each task has its own long-lived context. Open a task, and **任务详情** (task detail) on the right holds the background with your own words, the output, the files it read, the progress, what counts as done, and which model the task uses. It keeps updating as the task moves, and if another model or executor takes over, it reads the same context.

![Open a project and a task: the task detail holds the background, the output, the progress, the criteria, and which model the task uses](docs/readme/task-context.gif)

Delivered files open right in **交付** (delivery). If it's fine, click **验收通过** (accept); to change something, click **请求修改** (request changes) and say what to change. What comes back is version 2.

### 4. Keep working: context keeps accumulating, and your assistant understands you better and better

**Computer History** turns what you do on your computer into a timeline: one entry per 10 minutes, saying what you were doing and which apps you used. It is off by default, needs Screenpipe on your machine, and is turned on under **活动与设备** (activity and devices) in assistant settings. After that you can simply ask:

> 用一张可视化的图，展现我今天做了什么 (show me what I did today as a picture)

![Asking for today as a picture: a text answer first, then the data goes to a project, and ten minutes later a visual page comes back (demo data)](docs/readme/ask-visual.gif)

It first answers from the timeline in text. If you want the picture, reply 「做成一页网页」 (make it a web page): it hands today's data to a project, and a page you can open directly comes back. It remembers your habits too: say 「记住：我看东西习惯先看结论」 (remember: I read the conclusion first), and every conversation after that follows it.

### 5. Come back later

Before you go offline, tell Tacit what to do:

> I'm going offline and will check in the morning. Finish these three things overnight: an English version of the hiring page, jobs-en.html; a job description for the hiring site, jd.md; and a note on the interview process, process.md, saying what the first, second and final interviews each look at.

![Handing over three things before going offline; back on the board: where the project stands, what waits for acceptance, the suggestions left overnight](docs/readme/night-and-morning.gif)

When you come back, look at **待你决定** on the right: **项目进展** (project progress) says where each project stands and what waits for your acceptance; **新消息与建议** (messages and suggestions) holds what it left for you overnight, and a click on one writes a sentence into the input box. You can also just ask it what happened overnight. At night it only reads: it sends no messages for you, changes no files and opens no tasks.

### 6. Frame a piece of the screen and ask

You see something in another app and want to ask about it, without switching back or copying and pasting: press ⌥⇧M, frame that piece of the screen, and type a sentence in the small window that opens. The personal assistant knows your projects and tasks, and the answer appears in the same window. macOS only for now, through a small Mac helper that is not in this repository yet.

![Asking with a screenshot: press ⌥⇧M, frame a piece, type a sentence in the small window, and the answer appears there (composed demonstration)](docs/readme/shot-ask.gif)

## Reference

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

For switching models and executors, and what to do when something goes wrong, see the [guide](docs/GETTING-STARTED.en.md#later-on).

## More thinking

The steps above get you started. Why DSH-projects is built this way, how context is organised, assembled and collected, some early numbers and what is still unsolved are in a separate long piece: [Managing agents is managing context](https://hovocope135-tech.github.io/DSH-projects/site/blog/en/deep/).

- [Product page](https://hovocope135-tech.github.io/DSH-projects/site/), [film](https://github.com/hovocope135-tech/DSH-projects/releases/latest/download/tacit-film.mp4)
- [Getting started](docs/GETTING-STARTED.en.md); [features](docs/FEATURES.md) and [test report](docs/TESTING.md) (Chinese)

## Where it stands

Version 1.0. It runs only inside DeepSeek Harness, the interface is in Chinese for now, and Feishu is read-only. Claude Code as an executor has been run for real. Codex can be selected, but a complete task run on it has not been verified yet. Both run without permission prompts or a sandbox: they can read and write whatever your OS user can.

License: [MIT](LICENSE).
