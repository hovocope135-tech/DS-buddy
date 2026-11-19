^ Notes on building AI products
# Your next agent product doesn't need you to worry about agents
> Exploring the best way for people and AI to work together

![DSH-projects: the personal assistant Tacit on the left, the Waiting on you board on the right](img/rd2-hero.jpg)

Over the past six months, my strongest impression has been that agents keep getting more capable. On one hand I am amazed at how far AI has come; on the other, my own efficiency has improved only a little, and I often find myself running between several conversations.

The most central and urgent problem for AI applications today is lowering the bandwidth of communication between people and AI. On one hand, we need a good way to hand context to the AI; on the other, people shouldn't have to spend more of their attention to do it.

The dilemma we keep facing is that we are run off our feet, playing the role of glue most of the time, carrying context around, and short of real time to think and set the right direction.

Agent products today are built by carrying the experience of organising people over to AI. They hope to open more and more agents, without considering that so-called multi-agent collaboration then degrades into "several roles that can talk". It looks like collaboration, but at heart it is still a simulation of a human meeting room.

So before talking about multi-agent, we have to start with one question.

## Do we really need that many agents?

**Fork vs subagent: managing agents is, at heart, managing context.**

When do you need a fork, and when do you need multiple agents? The answer is that most of the time we don't need multiple agents.

A fork shares: the new branch is born with the context of the main conversation. Multi-agent passes things on: compress, retell, understand again, and every extra layer of passing loses a little more. Just as messages passed between people pick up errors, multiple agents pick up errors too, and they add a communication cost we don't need.

![A fork shares the context, noise included; multiple agents relay it and lose more at each layer](img/rd2-fork-en.jpg)

But a fork alone isn't enough: the main conversation keeps swelling. Context that grows by itself in a conversation tends to get worse and worse: small talk, stale conclusions and the noise of work in progress all stay in and keep using up the model's attention, and compression alone can't fix that.

Managing agents is, at heart, managing context. In a meeting-room style of multi-agent, each agent adds opinions from the point of view of a human job, but the task itself is never organised into a structure that can be delivered, verified and put together. That only moves the human form of organisation onto models, instead of designing the system around what agents can and can't do.

## The answer: context management built around the goal (the loop)

**Runtimes and sessions are only temporary tools; a vague goal is broken down into AI tasks that can close their own loop.**

AI needs a clear goal and acceptance criteria. For every core thread, the way of working has turned towards the goal, that is, the loop. So the best answer for context has to be designed consciously from the start, rather than refined as the conversation goes on. A task that is really fit to hand to another agent should be like a complete sub-problem that can be delivered on its own. It doesn't have to be big, but it has to be complete. DSH-projects deliberately has an agent maintain the organisation of each task, and offers automated tasks (tasks that run again on a schedule) to help you build your own task loops smoothly.

For each task, the problem with today's sessions is that most of the valuable context gets buried in the moving conversation. Yet the fixed index of a task is simple. It is usually a clear goal, where the repository is, the acceptance standard, and where the documents are.

So people only need to say three things clearly: what to do, where the context is, and what the standard is. The AI then breaks that down into a context pack for each task (thread). Think of the pack roughly as a goal file. It is what we really maintain over time, injected each time and updated each time.

![A task's details page, which is its context pack](img/rd2-pack.jpg)

As for the execution, the temporary agents are really tools. Their state is fragile; each is just a runtime, and the context is injected again each time. They hardly need maintaining.

![The context pack is kept over time; executors are disposable](img/rd2-exec-en.jpg)

## Hide the configuration details: trust the model, offer a board instead of forms, leave the rest to the AI

Similar multi-agent products on the market today all expose too much. Multica and Raft offer a good way to organise, through group chats and tickets being passed along, and their underlying abstractions are well made; I borrowed their thinking and the way they are built. But for a person, setting up channels, configuring roles and dividing up the work is hard work in itself.

The details need wrapping. How the context is assembled, at which layer the cache hits, how tokens are saved: all of this is under the hood and shouldn't be put in front of the user. Wrapping it well also pays off: with the stable part at the front, the model can reuse what it read last time, and a cache hit and a cache miss differ in cost by an order of magnitude.

So in DSH-projects there are no agents to name and no skills to configure. But how far each job has got, and which model it went to, is always visible: every task has a page of details, and whatever needs you is on one board called Waiting on you.

![The waiting lane of the board, and one task's progress and executor](img/rd2-board.jpg)

## Collecting context fully

**Freeing people from carrying information around, towards an always-on AI that really understands you.**

For an AI to take over this layer, it first needs to take in enough of your context. That brings in our most important design: collecting context. What you do on screen and the messages in Feishu come in continuously and are organised into a timeline every 10 minutes; files on your computer are read when needed. All of it is read-only and can be turned off at any time.

![The computer timeline, and the read-only source settings](img/rd2-timeline.jpg)

Capturing context automatically isn't new. Screenpipe is the best-known example, along with AirJelly, Littlebird and the Computer History built into Codex, and they have existed for a while. But most of them haven't closed the loop from context to action.

![Asking Tacit about a line from an interview: it finds the source in what the screen recorded](img/rd2-recall.jpg)

I think this is how we will work in future: people express preferences and values and give the key guidance only at the points where they are really needed, instead of being reduced, as today, to carriers of information whose attention suffers. That lets people focus on what really matters.

The core assistant in DSH-projects is called Tacit by default, meaning tacit understanding. I think a really good buddy should know all the relevant context before you open your mouth.

![Tacit's personality, name and shortcut](img/rd2-tacit.jpg)

## The biggest challenge: breaking work down well

The biggest problem today is whether the coordinator, the assistant that splits the work, can plan the division and the size of tasks soundly. So we recommend a strong model such as Claude Opus 5.5 or GPT-6 Astra for the personal assistant, the one that sets things up for you, to split tasks as well as possible. As models get smarter and the skills for dividing work get refined, this keeps getting better.

![Which model each assistant uses, on one page](img/rd2-models.jpg)

Come and try it.

DSH-projects: your next agent product doesn't need you to worry about agents.

Further reading:

- [Guide](guide/): how to work with Tacit
- [Architecture](deep/): how it is built
