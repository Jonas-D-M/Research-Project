import puppeteer, { Page } from 'puppeteer'
import { PuppeteerScreenRecorder } from 'puppeteer-screen-recorder'
import fluent_ffmpeg from 'fluent-ffmpeg'
import path from 'path'
import fs from 'fs'
import * as core from '@actions/core'
import * as glob from '@actions/glob'
import * as io from '@actions/io'
import { Cluster } from 'puppeteer-cluster'
import IComponent from './types/Component'
import { findNPMCommands, retry } from './utils'
import readme from './readme'

const minimalArgs = [
  '--autoplay-policy=user-gesture-required',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-dev-shm-usage',
  '--disable-domain-reliability',
  '--disable-extensions',
  '--disable-features=AudioServiceOutOfProcess',
  '--disable-hang-monitor',
  '--disable-ipc-flooding-protection',
  '--disable-notifications',
  '--disable-offer-store-unmasked-wallet-cards',
  '--disable-popup-blocking',
  '--disable-print-preview',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-setuid-sandbox',
  '--disable-speech-api',
  '--disable-sync',
  '--hide-scrollbars',
  '--ignore-gpu-blacklist',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-default-browser-check',
  '--no-first-run',
  '--no-pings',
  '--no-sandbox',
  '--no-zygote',
  '--password-store=basic',
  '--use-gl=swiftshader',
  '--use-mock-keychain',
]

const viewport = {
  deviceScaleFactor: 1,
  hasTouch: false,
  height: 1080,
  isLandscape: true,
  isMobile: false,
  width: 1920,
}

const browserConfig: puppeteer.LaunchOptions &
  puppeteer.BrowserLaunchArgumentOptions &
  puppeteer.BrowserConnectOptions = {
  headless: true,
  ignoreHTTPSErrors: true,
  args: minimalArgs,
  defaultViewport: viewport,
}

export default (() => {
  const initBrowser = async (executablePath: string) => {
    return new Promise<puppeteer.Browser>(async (resolve, reject) => {
      try {
        browserConfig.executablePath = executablePath
        const browser = await puppeteer.launch(browserConfig)
        console.info(
          `Browser is running with process id ${browser.process()?.pid}`,
        )
        resolve(browser)
      } catch (error) {
        reject(error)
        throw error
      }
    })
  }

  const initRecorder = (page: puppeteer.Page) => {
    return new Promise<PuppeteerScreenRecorder>(async (resolve, reject) => {
      try {
        const scrollDelay = 500
        const duration = await page.evaluate(
          scrollDelay =>
            (((document.body.scrollHeight - 1080) / 100) * scrollDelay +
              scrollDelay) /
            1000,
          scrollDelay,
        )

        console.log('the duration: ', duration)

        const recordConfig = {
          followNewTab: false,
          fps: 25,
          videoFrame: {
            width: 1920,
            height: 1080,
          },
          aspectRatio: '16:9',
          recordDurationLimit: duration,
        }
        const recorder = new PuppeteerScreenRecorder(page, recordConfig)
        console.log(`init recorder`)

        resolve(recorder)
      } catch (error) {
        reject(error)
        throw error
      }
    })
  }

  const initViewport = async (
    page: puppeteer.Page,
    resolution: { width: number; height: number },
  ) => {
    console.info('Setting viewport')
    await page.setViewport(resolution)
  }

  const recordLocalServer = async (
    executablePath: string,
    sitemap: Array<string>,
    isStatic: boolean,
  ) => {
    const url = 'http://127.0.0.1:3000'
    const browser = await initBrowser(executablePath)
    try {
      const urlMap = generateUrlMap(sitemap, url, isStatic)
      console.log(urlMap)

      console.info('Recording pages')

      await recordMultiplePages(executablePath, urlMap)

      console.info('Generating showcase video')
      await generateShowcaseVideo()

      console.info('Delete temp vid dir')
      fs.rmSync(path.join(process.cwd(), 'tmpvid'), { recursive: true })
    } catch (error) {
      console.log(error)
      throw error
    } finally {
      await browser.close()
    }
  }

  const recordMultiplePages = async (
    executablePath: string,
    urlMap: Array<string>,
  ) => {
    const browserconfig = browserConfig
    browserconfig.executablePath = executablePath
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_BROWSER,
      maxConcurrency: 3,
      puppeteerOptions: browserconfig,
      timeout: 60000,
    })
    try {
      let index = 1
      await cluster.task(async ({ page, data: url, worker }) => {
        await recordPage(page, url, `${index}-${worker.id}`)
        index++
      })
      cluster.on('taskerror', (err, data, willRetry) => {
        if (willRetry) {
          console.warn(
            `Encountered an error while crawling ${data}. ${err.message}\nThis job will be retried`,
          )
        } else {
          console.error(`Failed to crawl ${data}: ${err.message}`)
        }
      })
      urlMap.forEach(url => {
        console.log(url)

        cluster.queue(url)
      })
    } catch (error) {
      throw error
    } finally {
      await cluster.idle()
      await cluster.close()
    }
  }

  const generateShowcaseVideo = (vidName?: string) => {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const videoName = vidName ?? 'showcase-video.mp4'

        let mergedVideo = fluent_ffmpeg()

        const tmpDirPath = path.join(process.cwd(), 'tmpvid')
        const finalDirPath = path.join(process.cwd(), 'video')
        const showcaseVidPath = `${process.cwd()}/showcase/video/${videoName}`

        await io.mkdirP(path.dirname(showcaseVidPath))

        const tmpVideos = fs
          .readdirSync(tmpDirPath)
          .map(f => path.join(tmpDirPath, f))

        console.log(tmpVideos)

        tmpVideos.forEach(vid => {
          mergedVideo = mergedVideo.addInput(vid)
        })
        // create file if not exists
        mergedVideo
          .mergeToFile(showcaseVidPath)
          .on('error', err => {
            throw err
          })
          .on('end', () => resolve())
      } catch (error) {
        reject(error)
        throw error
      }
    })
  }

  const generateUrlMap = (
    routes: Array<string>,
    baseUrl: string,
    isHTML = false,
  ) => {
    return routes.map(route => `${baseUrl}${route}${isHTML ? '.html' : ''}`)
  }

  const recordPage = async (page: Page, url: string, index: string) => {
    // const [page] = await browser.pages()
    const resolution = { width: 1920, height: 1080 }
    await initViewport(page, resolution)
    // await retry(() => page.goto(url, { waitUntil: 'load' }), 1000)
    await page.goto(url, { waitUntil: 'networkidle0' })
    const recorder = await initRecorder(page)
    console.log('Starting recorder')
    await recorder.start(`./tmpvid/tmp-${index}.mp4`)
    console.log('autoscrolling')
    await autoScroll(page)
    console.log('autoscrolling stopped')
    await recorder.stop()
    console.log('recorder stopped')
    await page.close()
  }

  const getAllPages = (isHtml: boolean, chromePath: string) => {
    console.log('getting all the pages...')

    return new Promise<Array<string>>(async (resolve, reject) => {
      try {
        const baseurl = `http://127.0.0.1:3000`

        let url = ''
        if (isHtml) {
          url = `${baseurl}/index.html`
        } else {
          url = `${baseurl}/index.html`
        }

        const browser = await initBrowser(chromePath)
        const page = await browser.newPage()
        await retry(
          () =>
            page.goto(url, {
              waitUntil: 'networkidle0',
            }),
          1000,
        )
        const hrefs = [
          ...new Set(
            await page.evaluate(() =>
              Array.from(document.getElementsByTagName('a'), links => {
                console.log(links)

                return links.href
                  .replace('http://127.0.0.1:3000', '')
                  .replace('#', '')
                  .replace('.html', '')
              }),
            ),
          ),
        ]
        console.log(hrefs)

        const filteredHrefs = hrefs.filter(href => !href.includes('http'))
        console.log(filteredHrefs)

        resolve(filteredHrefs)
        browser.close()
      } catch (error) {
        reject(error)
        throw error
      }
    })
  }

  const screenshotComponents = async (
    executablePath: string,
    isStatic: boolean,
    projectDir: string,
  ) => {
    core.startGroup('Screenshot components')
    const browserconfig = browserConfig
    browserconfig.executablePath = executablePath
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_BROWSER,
      maxConcurrency: 3,
      puppeteerOptions: browserconfig,
      timeout: 60000,
    })

    const components: Array<IComponent> = require(`${projectDir}/components.json`)

    try {
      await cluster.task(
        async ({ page, data: { url, cssSelector, name, dir }, worker }) => {
          console.log('cluster task data: ', { url, cssSelector, name, dir })

          await screenshotComponent(page, url, cssSelector, name, dir)
        },
      )

      cluster.on('taskerror', (err, data, willRetry) => {
        if (willRetry) {
          console.warn(
            `Encountered an error while crawling ${data}. ${err.message}\nThis job will be retried`,
          )
        } else {
          console.error(`Failed to crawl ${data}: ${err.message}`)
        }
      })

      components.forEach(({ name, page, selector }) => {
        cluster.queue({
          url: `http://127.0.0.1:3000/${page}${isStatic ? '.html' : ''}`,
          cssSelector: selector,
          name,
          dir: projectDir,
        })
      })
      core.endGroup()
    } catch (error) {
      throw error
    } finally {
      await cluster.idle()
      await cluster.close()
    }
  }

  const screenshotComponent = async (
    page: Page,
    url: string,
    cssSelector: string,
    name: string,
    projectDir: string,
  ) => {
    await page.goto(url)
    // ensure the component is loaded
    await page.waitForSelector(cssSelector)
    const component = await page.$(cssSelector)
    await component?.screenshot({
      path: `${projectDir}/showcase/screenshots/${name}.png`,
    })
    await page.close()
  }

  const createRecording = async (isStatic: boolean, chromePath: string) => {
    if (!isStatic) {
      const sitemap = await getAllPages(false, chromePath)

      await recordLocalServer(chromePath, sitemap, false)
    } else {
      core.notice('No package.json found, handling it as a regular HTML site')

      core.startGroup('Creating local server...')
      const sitemap = await getAllPages(true, chromePath)
      core.endGroup()

      core.startGroup('Creating recording...')
      await recordLocalServer(chromePath, sitemap, true)
      core.endGroup()
    }
  }

  const addScreenshotsToReadme = (
    projectDir: string,
    readmeName = 'README.md',
  ) => {
    return new Promise<void>(async (resolve, reject) => {
      try {
        const assetDir = 'showcase/screenshots/'
        const showcaseScreenshotDir = `${projectDir}/${assetDir}`

        const sectionTitle = '# Components'

        // read the screenshots
        let readmeString = `${sectionTitle}`

        const patterns = [`${showcaseScreenshotDir}*.png`]

        const globber = await glob.create(patterns.join('\n'))

        const files: Array<string> = (await globber.glob()).map((f: string) => {
          return path.relative(projectDir, f)
        })

        files.forEach(filePath => {
          const filename = filePath.replace(assetDir, '').replace('.png', '')
          return (readmeString += `\n## ${filename}\n<p>\n\t<img src="${filePath}"/>\n</p>\n`)
        })

        console.log(readmeString)

        const content = await readme.getReadme(projectDir, readmeName)

        const replacedContents = readme.replaceSection({
          section: 'components',
          oldContents: content,
          newContents: readmeString,
        })

        fs.writeFileSync(`${projectDir}/${readmeName}`, replacedContents, {
          encoding: 'utf-8',
          flag: 'w',
        })
        resolve()
      } catch (error) {
        reject(error)
      }
    })
  }

  return {
    screenshotComponents,
    createRecording,
    addScreenshotsToReadme,
  }
})()

const smoothAutoScrollV2 = async (page: Page) => {
  page.on('console', async msg => {
    const msgArgs = msg.args()
    for (let i = 0; i < msgArgs.length; ++i) {
      console.log(await msgArgs[i].jsonValue())
    }
  })
  await page.evaluate(async () => {
    await new Promise<void>((resolve, reject) => {
      try {
        const totalHeight = document.body.scrollHeight
        const viewport = window.innerHeight
        let topP = 0
        const timer = setInterval(() => {
          window.scrollBy({ top: topP, behavior: 'smooth' })

          topP = topP + viewport
          if (topP >= totalHeight) {
            clearInterval(timer)
            resolve()
          }
        }, 1500)
      } catch (error) {
        reject(error)
        throw error
      }
    })
  })
}

const smoothAutoScroll = async (page: Page) => {
  page.on('console', async msg => {
    const msgArgs = msg.args()
    for (let i = 0; i < msgArgs.length; ++i) {
      console.log(await msgArgs[i].jsonValue())
    }
  })
  await page.evaluate(async () => {
    return new Promise<void>((resolve, reject) => {
      try {
        let totalHeight = 0
        const docHeight = document.body.scrollHeight
        const delay = 1 //delay in milliseconds

        let timer = setInterval(() => {
          window.scroll(0, totalHeight)
          totalHeight += 5

          if (totalHeight > docHeight) {
            console.log(totalHeight)

            clearInterval(timer)
            resolve()
          }
        }, delay)
      } catch (error) {
        reject(error)
        throw error
      }
    })
  })
}

const autoScroll = async (page: Page) => {
  await page.evaluate(
    () =>
      new Promise<void>(async (resolve, reject) => {
        try {
          let totalHeight = -200
          let distance = 100
          let firstTime = true
          const timer = setInterval(() => {
            let scrollHeight = document.body.scrollHeight
            if (totalHeight >= scrollHeight) {
              console.log('clear interval')
              clearInterval(timer)
              console.log('interval cleared')

              resolve()
            }
            if (!firstTime) {
              window.scrollBy(0, distance)
              totalHeight += distance
            } else {
              firstTime = false
            }
          }, 500)
        } catch (error) {
          reject(error)
          throw error
        }
      }),
  )
}
