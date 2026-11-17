# 对标：Manus、Genspark、Raft 怎么做官网和发布文章

2026-11-16 读了三家的官网、发布文章和博客，记下它们的做法，以及 DS-buddy 的落地页和文章各学了哪一条。每条后面是出处，方便你自己去看。同一天产品页和发布文公开之后，又按线上的版本逐项核对了一遍（第三节），DS-buddy 这一列写的都是线上现在能看到的东西。三家那几列也在当天中午重新打开各自的页面核对过：记下的事实大多成立，有五处不对，已经改掉，改了什么写在第五节。

## 一、官网

### Manus（manus.im）

- 首屏几乎没有文案：一条公告条「Introducing Manus 2.0」，一个 Manus 2.0 介绍片的封面（点了才播放），一个输入框，标题就是一句问话「What can I do for you?」，下面一排起手的快捷项（Create slides、Build website、Develop games…）。
- 全页只有一句口号：「Less structure, more intelligence.」
- 没有数字、没有客户 logo、没有评价。可信度靠产品本身和页脚的 Trust center。
- 页脚有一组「Compare」：VS ChatGPT、VS Lovable、VS Replit。导航里有价格页。

**学到的：** 首屏用产品最有代表性的那个动作开场，而不是一段介绍。DS-buddy 的首屏是一句交代的话，下面直接是它变成的看板。

### Raft（raft.build）

- 顶部一条公告条（Builder 计划开放申请）。首屏：一句标题「Where humans and AI agents build together.」，一句定义「The agent-native workspace for builders and teams.」，两个按钮（Download Raft、Request a demo），一段模拟的团队对话界面。
- 接着是一句引语当论点：「The future of work isn't humans using AI tools. It's humans and AI agents building together.」
- 「What makes Raft different」下面四节，每节一句小标题加一张界面：Teammates who really know you、Work that finishes itself、Bring the agents you already run、A team that gets smarter together。
- 然后是七条用户评价（多数是创始人和 CTO，评价里带数字）、团队介绍（人和 agent 混排）、八个常见问题（含和 Slack、OpenClaw、Codex 或 Claude Code 的区别）、收尾按钮「Ready to build?」。导航里有价格、文档、用例。

**学到的：** 页面骨架。标题 + 一句定义 + 两个按钮 + 真界面；一句论点；「有什么不一样」每节一句话一张图；常见问题里直接回答「和谁有什么不同」；结尾再给一次按钮。DS-buddy 的落地页就是这个顺序。评价和团队两节我们现在没有，没有硬凑。

### Genspark（genspark.ai）

- 第一次读的时候官网拦了自动读取，发布时的打法是从 VentureBeat 的报道里看的。复核时在浏览器里能打开首页了。
- 首页是应用式的：一条版本公告「Genspark AI Workspace 6.0」，一句口号「Your all-in-one AI workspace」，一个输入框（「Ask anything, create anything」），旁边是产品目录（AI 队友、媒体工作室、办公套件、构建套件）。页脚是一长串按用途分的工具页，还有一个 Comparisons 入口。首页上没有数字、评价和常见问题。博客没有读。
- 发布时的打法是演示先行：三个具体场景（五天圣地亚哥行程并电话订餐厅、做菜短视频、动画短片），再给数字（9 个模型、80 多个工具、GAIA 87.8% 对 Manus 的 86%）。

**学到的：** 数字要带比较对象和条件才有说服力。DS-buddy 的页面只放自己量过的四个数，每个都写了条件。

## 二、发布文章

### Manus《Introducing Manus 2.0》（英文约 1000 词，中文版约 2300 字）

- 开头三句：宣布发布；说这不是一次版本更新，而是新架构、新产品、新能力；用一个问题定调。
- 每个功能的写法固定：名字加冒号，后面三个短句（「Game Dev: Build it. Ship it. Play it together.」），然后一个具体场景，常常带一句「以前要怎样」，最后才是好处。全文对读者说「你」。
- 只有量过的地方给数字（Cascade：token 少 23.2%、时间少 28.2%、成本低 32%），并注明是「一个测试配置」。
- 结尾单独一节 Availability：现在哪里能用、哪些要邀请码。最后一句很短：「Manus empowers you to build. You decide what's worth building.」
- 复核读的是中文版：三节编号的正文加一节收尾，收尾里讲各端什么时候上线、新应用要邀请码；全文 22 张图、2 段视频。英文版最后那句这次没有核对。

### Raft《Is Having Agents in the Room Meant to Be Chaotic?》（约 1600 词）

- 用一个小场景开头：一屋子 agent 报数，报着报着全是重复。第一段的最后给出论点：「The agents are not broken. The room is.」
- 给问题起名字（AX，agent experience），再用两个功能（收件箱、扣住的草稿）当证据，配五张图。
- 结尾一节「What's next」承认还有没解决的更难的问题，留了一个联系邮箱，不催注册。

### Manus《Rebuilding Manus with Manus》（英文约 3500 词，中文版约 6800 字，工程复盘）

- 标题就承诺讲「改了什么、坏了什么」。开头是一个场景，不是论点。
- 十二节编号的教训。有具体数字，也有具体的失败（一个没人看的周末，agent 自己开出 200 多条待办）。
- 专门有一节「What isn't working yet」，结尾注明哪些数字是估计。

**学到的，用在 DS-buddy 的文章和页面上：**

| 做法 | 出处 | 用在哪 |
| --- | --- | --- |
| 开头先说「这不是什么」 | Manus 2.0 | 落地页第二屏的引语「多 agent 卷了一年，我们决定把 agent 藏起来」；发布说明里的「这不是又一个多 agent 群聊」 |
| 一句话论点，短到能被引用 | Raft 博客 | 发布文的标题「一个真正好的 agent 产品，不需要 agent 这层抽象」 |
| 先给问题起名字，再拿功能当证据 | Raft 博客 | 发布文先讲「别家把什么摆在你面前」，再讲「把 agent 拿掉之后」 |
| 一篇短的讲观点，长的拆解另放 | Manus 把发布文和工程复盘分成两篇 | 短文约 1800 字；各家怎么传上下文的拆解另成一页 |
| 功能 = 祈使短句 + 场景 + 好处 | Manus 2.0、Multica README | 落地页「说一句就够」「交付的是成品」几节 |
| 只给量过的数字，写明条件 | Manus 2.0、Genspark | 落地页「有据可循」四个数 |
| 写「现在还有哪些不行」 | Manus 复盘 | 落地页常见问题、拆解长文「还没做好的」一节、测试报告的「没验到的」 |
| 结尾单独说现在哪里能用，最后一句很短 | Manus 2.0 | 发布文以口号「只说目标，只管拍板。」收尾，后面一段说它是什么、代码在哪 |
| 常见问题里直接比较 | Raft、Manus 页脚 | 落地页「和 Raft / Manus 有什么不同」 |
| 说清学自谁 | 三家都没有，这是我们自己加的 | 落地页「学自谁」一表 |

## 三、逐项对照（2026-11-16，按公开后的线上版本核对）

官网。

| 项 | Manus | Raft | Genspark | DS-buddy 现在 |
| --- | --- | --- | --- | --- |
| 首屏 | 一句问话、一个输入框、一个介绍片封面 | 标题、一句定义、两个按钮、一段模拟的团队对话 | 一个输入框，旁边是产品目录 | 口号、一句定义、两个按钮；下面是一句交代的话和它变成的看板 |
| 一句论点 | 「Less structure, more intelligence.」 | 一句引语当论点 | 「Your all-in-one AI workspace」 | 第二屏引语「多 agent 卷了一年，我们决定把 agent 藏起来。」 |
| 功能怎么讲 | 首屏下一排起手的快捷项 | 四节，每节一句小标题加一张界面 | 产品目录和一长串工具页 | 七节，每节一句短标题，配界面截图或一段说明 |
| 数字 | 没有 | 页面本身不列，数字出现在用户评价里 | 首页没有；发布时给了带比较对象的数字 | 四个：489 项自动化测试、36 条走查记录、14 秒拆成两个任务、1 分 48 秒到第 2 版交付。后两个是单次实测，页面上写了条件 |
| 外部评价 | 没有 | 七条 | 首页没有 | 没有 |
| 团队介绍 | 没有 | 有，人和 agent 混排 | 首页没有 | 没有 |
| 常见问题 | 没有；页脚有一组 VS 对比 | 八个，含和 Slack、OpenClaw、Codex 或 Claude Code 的区别 | 没有；页脚有 Comparisons 入口 | 七个，含「和 Raft 这类有什么不同」「和 Manus、Genspark 这类有什么不同」「现在还有哪些不行」 |
| 演示片 | 首屏就是介绍片的封面 | 首页没有视频 | 首页没有视频 | 85 秒，真实界面，演示数据，任务是模型当场做的 |
| 价格 | 有价格页 | 有价格页 | 首页只有联系销售 | 开源，MIT 许可证，花钱的只有自己选的模型 |
| 说清学自谁 | 没有 | 没有 | 没有 | 有一张表，七行 |

三家的演示片内容这次都没有播放来看。

发布文章。DS-buddy 一列写的是 11 月 16 日下午重写后的线上版本：一篇短文，加一页单独的拆解长文。

| 项 | Manus 2.0 发布文 | Raft 博客 | Manus 工程复盘 | DS-buddy 发布文现在 |
| --- | --- | --- | --- | --- |
| 篇幅 | 英文约 1000 词 | 约 1600 词 | 英文约 3500 词 | 短文中文约 1800 字、英文约 1350 词；拆解长文约 6500 字 |
| 开头 | 宣布发布，说这不是一次版本更新 | 一个小场景，第一段末尾给论点 | 一个场景 | 一句宣布开源，一句说这篇讲为什么这么做，然后从别家产品先让你认识 agent 讲起 |
| 论点 | 用一个问题定调 | 「The agents are not broken. The room is.」 | 十二节编号的教训 | 标题就是论点：「一个真正好的 agent 产品，不需要 agent 这层抽象」 |
| 证据 | 每个功能一个具体场景，22 张图、2 段视频 | 两个功能，五张图 | 具体数字和具体的失败 | 短文七张取自演示片的图；拆解长文七张示意图、七张图 |
| 数字 | 只给量过的，注明是一次测试配置 | 没有记到 | 有，并说明哪些是估计 | 不放用时数字 |
| 还没做好的 | 没有记到 | 结尾一节提到还有没解决的问题 | 专门一节（第 10 节） | 短文里没有；拆解长文有专门一节 |
| 结尾 | 收尾一节说现在哪里能用，最后一句很短 | 留一个联系邮箱，不催注册 | 两节：接下来做什么、人们现在在做什么 | 口号收尾，再一段说它是什么、代码在哪、拆解长文在哪 |

「没有记到」的意思是：读的时候没有把这一项记下来，不等于对方没有。

## 四、和它们比，DS-buddy 现在差在哪

- **没有外部评价，也没有团队介绍。** Raft 有七条创始人的话，还有一节团队。我们要等第一批用户。
- **没有独立域名和下载页。** 产品页挂在 GitHub Pages 上，安装从 GitHub 仓库走。
- **英文不全。** 产品页、README 和发布文有英文；上手指南、功能介绍、测试报告和界面本身只有中文。
- **页面上的两个用时数字是单次实测。** Manus 的数字来自一个测试配置，Genspark 的带着比较对象；我们的还没有多次的统计。
- **「带上你已经在用的 agent」还不能全说。** 这在 Raft 是卖点。我们这边 Claude Code 实跑验证过；Codex 用它自己的模型跑通，还没有验证到（见测试报告）。
- **三家都是独立产品，有价格页、下载或注册入口。** DS-buddy 是 DeepSeek Harness 里的一个插件，入口是 GitHub 仓库和三条安装命令。

比起这份记录的上一版，已经补上的：演示片有了（85 秒，真实界面）；发布文有了英文版；产品页有了公开网址。

## 五、复核时改掉的五处（2026-11-16 中午）

重新打开三家的页面，把这份记录里写它们的每一条都对了一遍。Manus 和 Raft 的官网、Manus 的两篇文章读到的是中文版，引用的英文原句沿用第一次读的记录。

- Manus 首屏那张图不是产品截图，是 Manus 2.0 介绍片的封面。
- Raft「有什么不同」是四节，不是四五节。
- Raft 的常见问题是八个，不是七个。
- Raft 那篇博客配的是五张图，不是三张；论点在第一段末尾，不是第三句。
- Genspark 的首页这次能读到了，补进了第一节和对照表。

其余都对得上：Manus 的口号、输入框、快捷项、页脚的对比和信任中心；Raft 的标题、定义、两个按钮、引语、七条评价、团队、收尾；Manus 2.0 发布文的开头三句、三个数字和「一次测试配置」；Raft 博客的报数开头、AX、收件箱和扣住的草稿；Manus 工程复盘的十二节和「哪些还没做好」；VentureBeat 报道里的三个场景和四个数字。

## 出处

- Manus 官网：https://manus.im
- Manus 2.0 发布文章：https://manus.im/blog/introducing-manus-2-0
- Manus 工程复盘：https://manus.im/blog/rebuilding-manus-with-manus
- Raft 官网：https://raft.build
- Raft 博客：https://raft.build/resources/blog/is-having-agents-in-the-room-meant-to-be-chaotic/
- Genspark 发布报道（VentureBeat）：https://venturebeat.com/business/gensparks-super-agent-ups-the-ante-in-the-general-ai-agent-race
- DS-buddy 产品页（线上）：https://hovocope135-tech.github.io/DS-buddy/site/
- DS-buddy 发布文（线上）：https://hovocope135-tech.github.io/DS-buddy/site/blog/ ，英文 https://hovocope135-tech.github.io/DS-buddy/site/blog/en/ ，拆解长文 https://hovocope135-tech.github.io/DS-buddy/site/blog/deep/
