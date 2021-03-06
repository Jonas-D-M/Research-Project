# Research Project Action
This action records a video of your website (static HTML or with the help of a Javascript framework) and puts it in the showcase folder. Ready for you to access it and use it.

## Features
- Create or append readme with screenshots of components
- Concurrently create videos to save on execution time.
- Get available pages based on clickable links on home page.

## Usage
### Action workflow
```
runs-on: ubuntu-latest
steps:
    - name: checkout repo
        uses: actions/checkout@v2
    - name: Research Project Action
        uses: Jonas-D-M/Research-Project@v1.0.0
```
### Specifiy components
Create a `components.json` file inside the root directory of the project with the following structure:
```
[
  {
    "name": name of the component,
    "page": name of the page on wich to find the component (no extension),
    "selector": css selector
  },
 ...
]

```

## How it works
This action makes use of Puppeteer and its ability to create screenshots in conjunction with a screen recorder plugin for Puppeteer.
The plugin makes use of the native chrome devtool protocol for capturing video frame by frame. The created assets are stored in a newly created folder: `showcase/`
If you want to access these assets, you can retrieve them via the Github API.

## Local Development

### `npm run dev`
Runs the project in development/watch mode. The project will be rebuilt upon changes. For testing purposes, change the projectDir variable inside `action.ts` to a folder with a testable project.

### `npm run build`
Compiles the typescript code to javascript and uses Vercel ncc to create a single javascript file with all the node_modules.
