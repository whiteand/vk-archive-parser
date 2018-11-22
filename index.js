const path = require('path')
const { promisify, inspect } = require('util')
const fs = require('fs')
const insplog = (...values) => {
  if (!values.length) return
  for (const v of values) {
    console.log(inspect(v, { colors: true, depth: 100 }))
  }
}
const iconv = require('iconv-lite')
const parse5 = require('parse5')
const MESSAGES_FOLDER = 'messages'
const MESSAGE_CLASS = 'message'
const MESSAGE_HEADER_CLASS = 'message__header'

function getArchivePath() {
  const [, , archiveRelPath] = process.argv;
  const archivePath = path.resolve(process.cwd(), archiveRelPath);
  return archivePath
}

function getMessagesPath(archivePath) {
  return path.resolve(archivePath, `./${MESSAGES_FOLDER}`)
}

async function getMessagesFolders(messagesPath) {
  const messagesDirStats = await promisify(fs.stat)(messagesPath)
  if (!messagesDirStats.isDirectory()) {
    throw new Error(`archive hasnt '${MESSAGES_FOLDER}' folder`)
  }
  const messagesFolderContent = await promisify(fs.readdir)(messagesPath)
  const userFolderPaths = messagesFolderContent.map(file => path.resolve(messagesPath, file))
  const userFoldersStatsWithPaths = await Promise.all(
    userFolderPaths.map(p =>
      promisify(fs.stat)(p).then(stats => ({ path: p, stats }))
    )
  )
  const foldersPaths = userFoldersStatsWithPaths.reduce((folders, { stats, path }) => {
    if (stats.isDirectory()) {
      folders.push(path)
    }
    return folders
  }, [])
  return foldersPaths
}

async function getFoldersWithFileNames(folderPaths) {
  const foldersWithFileNames = await Promise.all(
    folderPaths.map(
      folderPath => promisify(fs.readdir)(folderPath)
        .then(files => ({
            path: folderPath,
            files: files.map(file => path.resolve(folderPath, file))
          })
        )
    )
  )
  return foldersWithFileNames
}
function getClasses (node) {
  const { attrs } = node
  if (!attrs) return []
  if (!Array.isArray(attrs)) return []
  const classAttrs = attrs.filter(({ name }) => name === 'class')
  return classAttrs.map(e => e.value).join(' ').split(' ')
}
function getNodesByPredicate(node, predicate, whileCond = () => true) {
  const res = []
  if (!node) return []
  const _goDeeper = node => {
    if (!whileCond(node)) {
      return
    }
    if (predicate(node)) {
      res.push(node)
    }
    if (!node.childNodes || node.childNodes.length === 0) return
    
    for (const child of node.childNodes) {
      _goDeeper(child)
    }
  }
  _goDeeper(node)
  return res
}
function getElementsByClassName(node, className) {
  return getNodesByPredicate(node, node => getClasses(node).includes(className))
}

function getMessageHeader (messageNode) {
  return getElementsByClassName(messageNode, MESSAGE_HEADER_CLASS)[0]
}
function parseAuthorName(messageNode) {
  const headerNode = getMessageHeader(messageNode)
  const links = getNodesByPredicate(headerNode, a => a.tagName === 'a')
  if (links.length === 0) return 'You'
  const [firstLink] = links
  return firstLink.childNodes[0].value.trim()
}

function parseDate(messageNode) {
  const headerNode = getMessageHeader(messageNode)
  const texts = getNodesByPredicate(headerNode, node => node.nodeName === '#text')
  const textWithDate = texts.find(({value}) => /, \d{1,2} \S{2,3} \d{4}/.test(value))
  const dateText = textWithDate.value.match(/\d{1,2} \D{2,3} \d{4} \D \d{1,2}:\d{1,2}:\d{1,2}.*$/g)[0]
  if (!dateText) return null
  const [, day, month, year, hour, minute, seconds] = dateText.match(/(\d{1,2}) (\D{3}) (\d{4}) . (\d{1,2}):(\d{1,2}):(\d{1,2})/)
  const yearNumber = Number(year)
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const monthNumber = months.indexOf(month)+1
  const dayNumber = Number(day)
  return {
    year: yearNumber,
    month: monthNumber,
    day: dayNumber,
    hour: Number(hour),
    minute: Number(minute),
    second: Number(seconds)
  }
}
function parseMessageText(messageNode) {
  const isNotMessageHeader = node => !getClasses(node).includes(MESSAGE_HEADER_CLASS)
  const isText = node => {
    return node.nodeName === '#text'
  }
  const texts = getNodesByPredicate(messageNode, isText, isNotMessageHeader)
  const res = texts.map(t => t.value).join('\n\n').replace(/\n+\s+/g, '\n')
  return res.trim()
}

function parseMessageNode(messageNode) {
  const text = parseMessageText(messageNode)
  return {
    text: text.replace(/(\n+\s+)/g, '\n'),
    author: parseAuthorName(messageNode),
    date: parseDate(messageNode)
  }
}

async function parsePage(pageFile) {
  const htmlContentBuffer = await promisify(fs.readFile)(pageFile)
  const text = iconv.decode(htmlContentBuffer, 'win1251')
  const doc = parse5.parse(text)
  const messagesNodes = getElementsByClassName(doc, MESSAGE_CLASS)
  const messages = messagesNodes.map(parseMessageNode)
  const parsedMessages = messages.filter(e => !(e instanceof Error))
  return parsedMessages
}

async function populateFolderWithPages(folder) {
  const { files } = folder
  const htmlFiles = files.filter(file => path.extname(file) === '.html')
  if (!htmlFiles.length) {
    return {
      ...folder,
      pages: []
    }
  }
  const pages = []
  for (const htmlFile of htmlFiles) {
    const page = await parsePage(htmlFile)
    pages.push(page)
  }
  return {
    ...folder,
    pages
  }
}

async function parseArchive(archivePath) {
  const messagesPath = getMessagesPath(archivePath)
  const messagesFolders = await getMessagesFolders(messagesPath)
  const foldersWithFileNames = await getFoldersWithFileNames(messagesFolders)
  const foldersWithUserIds = foldersWithFileNames.map(folderInfo => ({
    ...folderInfo,
    userId: path.basename(folderInfo.path)
  }))
  const foldersWithParsedPages = await Promise.all(foldersWithUserIds.map(populateFolderWithPages))
  const foldersWithUsers = foldersWithParsedPages.map(folder => ({
    userId: folder.userId,
    messages: folder.pages.reduce((a,b) => a.concat(b), [])
  }))
  const json = JSON.stringify(foldersWithUsers)
  return json
}
async function main() {
  try {
    const archivePath = getArchivePath();
    const parsedJson = await parseArchive(archivePath)
    process.stdout.write(iconv.encode(parsedJson, "utf8").toString())
  } catch (error) {
    insplog({ error })
  }
}

main()

