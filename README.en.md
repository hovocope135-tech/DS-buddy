# DSH-projects

**Exploring the best way for people and AI to work together**

[中文](README.md)

For the past six months I have kept running into the same kind of tiredness: the models keep getting stronger, and my own output hasn't kept up. Most of my day goes into switching between a few conversation windows, carrying one side's output over and filling in what the other side missed. Somewhere along the way I became the glue between AIs, with no time left to think the direction through.

The problem isn't that AI isn't smart enough. It's that the bandwidth between people and AI is too limited. I built DSH-projects to explore a new way of interacting, one that takes this needless layer of friction out of working with AI.

Here are the core principles we built DSH-projects on:

**Most of the time, you don't need multiple agents. Managing agents is, at heart, managing context.**

Many products put the way human teams are organised straight onto AI: a pile of agents, roles, channels, tickets. It looks busy, but it is still a simulated meeting room, with a human division of labour covering up context that has been split apart. To a model, a fork shares and multiple agents pass things along. Whatever is passed along loses something. Rather than having agents message each other, fork the subtasks from one complete context. For most complex problems, that is enough.

**Build context around goals (loops).**

The key to using AI well is to split the work into a structure that can be verified and has a clear goal: one goal and one loop at a time. Without role play to divide the work, what needs maintaining is the tasks themselves. In DSH-projects the assistant keeps a set of task files (goals): what the goal is, what counts as done and where the context lives are all written down. Every core thread has a stable context; add automations that run on a schedule, and everyday work turns into loops that run without anyone watching.

**We don't need the concept of an agent. The runtime details and the dynamic, fragmented state should stay hidden.**

I would go further: the agent itself is a needless middle layer. In products like Multica, you configure Skills and runtimes for your agents before any work starts. But tools and environments are just task context; they should grow as the project needs them, not be fixed in advance. So DSH-projects keeps the fragmented runtime state underneath and exposes only the model. Every extra layer of agent is one more thing to keep in your head. The one thing you need to care about is a sentence per project on which models to prefer.

**You can do without the agent abstraction, but every runtime should stay visible.**

Hiding concepts doesn't mean building a black box. When tasks run on their own in the background, people need something to rely on. So while it takes away the agent abstraction, DSH-projects gives every run a clear view: when the assistant was woken and by what, which tools it called in order, and how it turned out, all in the developer view.

**Take in as much context as possible, use the best model to assign the work, then let the AI explore.**

Building this product has also meant slowly letting go of control. I believe more and more that enough context and room to explore beat any amount of prompt polishing. DSH-projects turns what you do on your computer into a timeline and hands it to the model as background; what the model is unsure about lands on a board called Waiting on you. You make the calls at the key points, and it finds the rest of the way.

**A small suggestion: give the personal assistant the best model you can.**

The personal assistant, the coordinator, does the work that takes the most judgement: understanding what you mean and breaking vague ideas into tasks of the right size. If that first split goes wrong, no speed afterwards will save it. So give it the best model you can use, such as Claude Opus 5.5 or GPT-6 Astra. Put your best tool where it counts.

Install it and try.

## How to use it

The interface is in Chinese for now.

**Install.** You need DeepSeek Harness (tested on 0.2.1) and Node 24 or later. If you do not have DeepSeek Harness yet: `npm install -g @deepseek-ai/dsh`.

```sh
git clone https://github.com/hovocope135-tech/DSH-projects
cd DSH-projects/plugin
dsh plugin --profile web add "$(pwd)"    # add the plugin to DeepSeek Harness
dsh --profile web                        # start it and open the address it prints
```

The sidebar gains a personal assistant and projects. The personal assistant is called Tacit by default and watches all your projects. With the Claude Code or Codex command line installed, tasks can go to them; with the Feishu command line (lark-cli) installed and authorised, Tacit can read your Feishu messages, read-only.

**Hand over a job.** Create a project; you can give it a folder for the executor to work in. In the project's conversation, say in one sentence what to do, where the context is and what counts as good. The project assistant starts what it can and asks about what you left unclear.

Open a task to see all of its context: your own words, what counts as done, what it produced, the files it read, its progress.

**Accept and decide.** Finished tasks, Feishu messages waiting for your reply and Tacit's own suggestions all land in Waiting on you. On a computer with Screenpipe, what you do on screen becomes a timeline every 10 minutes, filed under a project when it is clear which one.

The cards have no buttons. Click a task card to open the task; delivered pages, images and documents preview in place. Accept it, or say exactly what to change. Click a message card and a whole request is written into the input box for you to edit and send.

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

## More

- [Introduction, full version](https://hovocope135-tech.github.io/DSH-projects/site/blog/en/): the long version of this introduction
- [Architecture](https://hovocope135-tech.github.io/DSH-projects/site/blog/en/deep/): how it is built
- [Product page](https://hovocope135-tech.github.io/DSH-projects/site/), [film](https://github.com/hovocope135-tech/DSH-projects/releases/latest/download/tacit-film.mp4)
- [Getting started](docs/GETTING-STARTED.md), [features](docs/FEATURES.md) and [test report](docs/TESTING.md) (Chinese)

## Where it stands

Version 1.0. It runs only inside DeepSeek Harness, the interface is in Chinese for now, and Feishu is read-only. Claude Code as an executor has been run for real. Codex can be selected, but a complete task run on it has not been verified yet. Both run without permission prompts or a sandbox: they can read and write whatever your OS user can.

License: [MIT](LICENSE).
