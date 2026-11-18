# DSH-projects

**Your next agent product may not need agents. Exploring the best way for people and AI to work together.**

[中文](README.md)

Do you keep switching between sessions, and does setting up each agent give you a headache? Do you wish you could keep a large number of agent conversations in hand without carrying context back and forth yourself?

If you are also looking for a better way to manage context, DSH-projects wants to offer the next way for people and AI to work together: hide every detail that isn't needed, let people focus on what really matters, and bring down the cost of working with AI.

These are the starting points DSH-projects is built on, and its main differences from similar agent products:

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

The interface is in Chinese for now, so the names on screen are given in Chinese below.

### 1. Set up your assistant

Install the plugin from npm, one command:

```sh
dsh plugin --profile web add deepseek-harness-projects-plugin@preview
dsh --profile web        # start it and open the address it prints
```

Before you start you need DeepSeek Harness (tested on 0.2.1; `npm install -g @deepseek-ai/dsh` if you don't have it), Node 24 or later, and an API key for your model.

<details>
<summary>Install from source</summary>

```sh
git clone https://github.com/hovocope135-tech/DSH-projects
cd DSH-projects/plugin
dsh plugin --profile web add "$(pwd)"    # add the plugin to DeepSeek Harness
dsh --profile web
```

</details>

On first open, follow the guide: pick the assistant's traits, give it a name, and choose a shortcut to call it up. It is called Tacit by default.

To let it know more, connect Feishu and your computer's files in **助理设置** (assistant settings), or turn on screen recording. All of it is optional and read-only, and it works with nothing connected.

### 2. Hand everything to your personal assistant

Tell the personal assistant what you need. It turns your request into a project by itself:

> We're hiring a front-end engineer who leans towards interaction and motion. Create a project 「前端招聘」 and start with two things: write a second-interview question set interview.md, three questions on motion and interaction details, each with scoring notes; then build a hiring page jobs.html that can go on the website.

![One sentence to the personal assistant: it creates the project, splits it into two tasks, and the first delivery comes back for acceptance](docs/readme/assistant-flow.gif)

Say what to do and what counts as good. How to split it into tasks is its call. Where something is unclear, it asks you first.

You don't have to watch. When a task is done it shows up under **待你决定** (waiting on you) on the right, for you to accept.

### 3. Manage tasks inside a project

Every project has several tasks. Open the project on the left, and **项目任务** (project tasks) on the right lists them with their states.

![Open a task: its detail panel on the right updates as the task moves, through delivery and acceptance](docs/readme/task-context.gif)

Each task has its own context. Open a task, and **任务详情** (task detail) on the right is that context:

- **背景 (background)**: what this job is, and your own words at the time.
- **怎么算完成 (what counts as done)**: the criteria written down when work starts, checked one by one at delivery.
- **进展 (progress)**: every step from opening the task to delivery, including the questions it asked you and your answers.
- **读过的文件 (files read)**: what it read for this job.
- **产出 (output)**: the delivered files. Each revision adds a version.

This context keeps updating as the task moves, so whenever you open it you see the latest. If another model or executor takes over, it reads the same context.

Delivered pages, images and documents open right in **交付** (delivery). If it's fine, click **验收通过** (accept). To change something, click **请求修改** (request changes) and say what to change.

### 4. Keep working: context keeps accumulating, and your assistant understands you better and better

**Computer History** turns what you do on your computer into a timeline: one entry per 10 minutes, saying what you were doing and which apps you used, filed under a project when it is clear which.

![The timeline, and the personal assistant answering "what did I do today" from it (demo data)](docs/readme/timeline.gif)

After that, when you ask 「今天做了什么」 (what did I do today), it answers with what you did yourself and what the projects produced, side by side. When you hand over something new, you don't explain the background from scratch.

Screen recording is off by default. It needs Screenpipe on your machine, and you turn it on under **活动与设备** (activity and devices) in assistant settings.

It remembers your habits too. Say 「记住：我看东西习惯先看结论」 (remember: I read the conclusion first), and every conversation after that follows it.

### 5. Come back later

Before you go offline, tell Tacit what to do:

> I'm going offline and will check in the morning. Finish these three things overnight: an English version of the hiring page, jobs-en.html; a job description for the hiring site, jd.md; and a note on the interview process, process.md, saying what the first, second and final interviews each look at.

When you come back, open **待你决定** on the right:

- Under **项目进展** (project progress) are the tasks that were delivered and wait for your acceptance.
- Under **新消息与建议** (messages and suggestions) are the cards Tacit left for you overnight, three at most: one thing that could be done, one thing worth a look, one thing it wants to say. Click a card and a sentence is written into the input box. Edit it, then send.

![The board in the morning: three deliveries waiting for acceptance, and the three cards Tacit left overnight](docs/readme/morning-board.png)

You can also just ask it what it did overnight. It gives the conclusion first, then the details.

![Asking what it did overnight: the conclusion first, then the details](docs/readme/morning-answer.png)

At night it only reads: it sends no messages for you, changes no files and opens no tasks. Without a word from you it makes no decisions and accepts nothing.

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
