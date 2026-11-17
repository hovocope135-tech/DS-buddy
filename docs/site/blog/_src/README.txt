Source of the DSH-projects posts served from docs/site/blog/.

content/zh.md, content/en.md              1. the introduction: the product's core ideas (also the top of the README)
content/zh-deep.md, content/en-deep.md    2. the architecture: a technical write-up
content/zh-guide.md, content/en-guide.md  3. the guide: how to work with Tacit, step by step
build.py                                  turns the six files into index.html, deep/, guide/, en/... and style.css, and draws the diagrams

To rebuild: copy the screenshots from ../img into ./img, run `python3 build.py` here, then copy public/ over docs/site/blog/.
No dependencies beyond Python 3.
