'use babel'

import {CompositeDisposable} from 'atom'
import path from 'path'
import {isValidEditor} from '../utils'

class Formatter {
  constructor (goconfig, goget) {
    this.goconfig = goconfig
    this.goget = goget
    this.subscriptions = new CompositeDisposable()
    this.saveSubscriptions = new CompositeDisposable()
    this.updatingFormatterCache = false
    this.setToolLocations()
    this.observeConfig()
    this.handleCommands()
    this.updateFormatterCache()
  }

  dispose () {
    if (this.subscriptions) {
      this.subscriptions.dispose()
    }
    this.subscriptions = null
    if (this.saveSubscriptions) {
      this.saveSubscriptions.dispose()
    }
    this.saveSubscriptions = null
    this.goget = null
    this.goconfig = null
    this.tool = null
    this.toolCheckComplete = null
    this.formatterCache = null
    this.updatingFormatterCache = null
    this.toolLocations = null
  }

  setToolLocations () {
    this.toolLocations = {
      gofmt: false,
      goimports: 'golang.org/x/tools/cmd/goimports',
      goreturns: 'github.com/sqs/goreturns'
    }
  }

  handleCommands () {
    atom.project.onDidChangePaths((projectPaths) => {
      this.updateFormatterCache()
    })
    this.subscriptions.add(atom.commands.add('atom-text-editor[data-grammar~="go"]', 'golang:gofmt', () => {
      if (!this.getEditor()) {
        return
      }
      this.format(this.getEditor(), 'gofmt')
    }))
    this.subscriptions.add(atom.commands.add('atom-text-editor[data-grammar~="go"]', 'golang:goimports', () => {
      if (!this.getEditor()) {
        return
      }
      this.format(this.getEditor(), 'goimports')
    }))
    this.subscriptions.add(atom.commands.add('atom-text-editor[data-grammar~="go"]', 'golang:goreturns', () => {
      if (!this.getEditor()) {
        return
      }
      this.format(this.getEditor(), 'goreturns')
    }))
  }

  observeConfig () {
    this.subscriptions.add(atom.config.observe('go-plus.format.tool', (formatTool) => {
      this.tool = formatTool
      if (this.toolCheckComplete) {
        this.toolCheckComplete[formatTool] = false
      }
      this.checkForTool(formatTool)
    }))
    this.subscriptions.add(atom.config.observe('go-plus.format.formatOnSave', (formatOnSave) => {
      if (this.saveSubscriptions) {
        this.saveSubscriptions.dispose()
      }
      this.saveSubscriptions = new CompositeDisposable()
      if (formatOnSave) {
        this.subscribeToSaveEvents()
      }
    }))
  }

  subscribeToSaveEvents () {
    this.saveSubscriptions.add(atom.workspace.observeTextEditors((editor) => {
      if (!editor || !editor.getBuffer()) {
        return
      }

      const bufferSubscriptions = new CompositeDisposable()
      bufferSubscriptions.add(editor.getBuffer().onWillSave((filePath) => {
        let p = editor.getPath()
        if (filePath && filePath.path) {
          p = filePath.path
        }
        this.format(editor, this.tool, p)
      }))
      bufferSubscriptions.add(editor.getBuffer().onDidDestroy(() => {
        bufferSubscriptions.dispose()
      }))
      this.saveSubscriptions.add(bufferSubscriptions)
    }))
  }

  ready () {
    return this.goconfig && !this.updatingFormatterCache && this.formatterCache && this.formatterCache.size > 0
  }

  resetFormatterCache () {
    this.formatterCache = null
  }

  updateFormatterCache () {
    if (this.updatingFormatterCache) {
      return Promise.resolve(false)
    }
    this.updatingFormatterCache = true

    if (!this.goconfig) {
      this.updatingFormatterCache = false
      return Promise.resolve(false)
    }

    const cache = new Map()
    const paths = atom.project.getPaths()
    paths.push(false)
    const promises = []
    for (const p of paths) {
      if (p && p.includes('://')) {
        continue
      }
      for (const tool of ['gofmt', 'goimports', 'goreturns']) {
        let key = tool + ':' + p
        let options = { directory: p }
        if (!p) {
          key = tool
          options = {}
        }

        promises.push(this.goconfig.locator.findTool(tool, options).then((cmd) => {
          if (cmd) {
            cache.set(key, cmd)
            return cmd
          }
          return false
        }))
      }
    }
    return Promise.all(promises).then(() => {
      this.formatterCache = cache
      this.updatingFormatterCache = false
      return this.formatterCache
    }).catch((e) => {
      if (e.handle) {
        e.handle()
      }
      console.log(e)
      this.updatingFormatterCache = false
    })
  }

  cachedToolPath (toolName, editor) {
    if (!this.formatterCache || !toolName) {
      return false
    }

    const p = this.projectPath(editor)
    if (p) {
      const key = toolName + ':' + p
      const cmd = this.formatterCache.get(key)
      if (cmd) {
        return cmd
      }
    }

    const cmd = this.formatterCache.get(toolName)
    if (cmd) {
      return cmd
    }
    return false
  }

  projectPath (editor) {
    if (editor) {
      const result = atom.project.relativizePath(editor.getPath())
      if (result && result.projectPath) {
        return result.projectPath
      }
    }
    const paths = atom.project.getPaths()
    if (paths && paths.length) {
      for (const p of paths) {
        if (p && !p.includes('://')) {
          return p
        }
      }
    }

    return false
  }

  checkForTool (toolName = this.tool, options = this.getLocatorOptions()) {
    if (!this.ready()) {
      return
    }
    return this.goconfig.locator.findTool(toolName, options).then((cmd) => {
      if (cmd) {
        return this.updateFormatterCache().then(() => {
          return cmd
        })
      }

      if (!this.toolCheckComplete) {
        this.toolCheckComplete = { }
      }

      if (!cmd && !this.toolCheckComplete[toolName]) {
        if (!this.goget) {
          return false
        }
        this.toolCheckComplete[toolName] = true

        const packagePath = this.toolLocations[toolName]
        if (packagePath) {
          this.goget.get({
            name: 'gofmt',
            packageName: toolName,
            packagePath: packagePath,
            type: 'missing'
          }).then(() => {
            return this.updateFormatterCache()
          }).catch((e) => {
            console.log(e)
          })
        }
      }

      return false
    })
  }

  getEditor () {
    if (!atom || !atom.workspace) {
      return
    }
    const editor = atom.workspace.getActiveTextEditor()
    if (!isValidEditor(editor)) {
      return
    }

    return editor
  }

  getLocatorOptions (editor = this.getEditor()) {
    const options = {}
    const p = this.projectPath(editor)
    if (p) {
      options.directory = p
    }

    return options
  }

  getExecutorOptions (editor = this.getEditor()) {
    const o = this.getLocatorOptions(editor)
    const options = {}
    if (o.directory) {
      options.cwd = o.directory
    }

    if (this.goconfig) {
      options.env = this.goconfig.environment(o)
    }
    if (!options.env) {
      options.env = process.env
    }
    return options
  }

  format (editor = this.getEditor(), tool = this.tool, filePath) {
    if (!isValidEditor(editor) || !editor.getBuffer()) {
      return
    }

    if (!filePath) {
      filePath = editor.getPath()
    }

    const formatCmd = this.cachedToolPath(tool, editor)
    if (!formatCmd) {
      this.checkForTool(tool)
      return
    }

    const cmd = formatCmd
    const options = this.getExecutorOptions(editor)
    options.input = editor.getText()
    const args = ['-e']
    if (filePath) {
      if (tool === 'goimports') {
        args.push('--srcdir')
        args.push(path.dirname(filePath))
      }
    }

    const r = this.goconfig.executor.execSync(cmd, args, options)
    if (r.stderr && r.stderr.trim() !== '') {
      console.log('gofmt: (stderr) ' + r.stderr)
      return
    }
    if (r.exitcode === 0) {
      editor.getBuffer().setTextViaDiff(r.stdout)
    }
  }
}
export {Formatter}