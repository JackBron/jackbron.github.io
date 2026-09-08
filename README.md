# jackbron.github.io

Static site served by GitHub Pages at <https://jackbron.github.io>.

## Layout

| Path | What it is |
|---|---|
| `index.html` | Landing page / project index. Plain HTML, no build step, no dependencies. |
| `line-studio/index.html` | Line Studio — single-file cooking-mode app. Deployed copy. |

## Adding a project

Copy the marked `<li class="project">` block in `index.html`. Each entry takes an
index number, a name, a status chip (`live` or `wip`), a description and a tag list.

## Updating Line Studio

The app's source of truth lives outside the published tree in `Cooking_Mode/`
(gitignored, along with the recipe JSON and PDFs — that folder holds third-party
recipe content and is deliberately not published). To ship a new revision:

```
cp Cooking_Mode/line_studio_<rev>.html line-studio/index.html
```

The revision string stays visible in the app's status bar, bottom right.
