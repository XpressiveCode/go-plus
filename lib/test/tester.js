'use babel'

import {CompositeDisposable} from 'atom'
import _ from 'lodash'
import fs from 'fs'
import os from 'os'
import parser from './gocover-parser'
import path from 'path'
import rimraf from 'rimraf'
import temp from 'temp'
import {isValidEditor} from '../utils'

class Tester {
  constructor (goconfig, testPanelManager) {
    this.goconfig = goconfig
    this.testPanelManager = testPanelManager
    this.subscriptions = new CompositeDisposable()
    this.saveSubscriptions = new CompositeDisposable()
    this.observeConfig()
    this.observeTextEditors()
    this.handleCommands()
    this.markedEditors = new Map()
    this.running = false
    temp.track()
  }

  dispose () {
    this.running = true
    this.removeTempDir()
    this.clearMarkersFromEditors()
    if (this.markedEditors) {
      this.markedEditors.clear()
    }
    this.markedEditors = null
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
    this.testPanelManager = null
    this.running = null
  }

  handleCommands () {
    this.subscriptions.add(atom.commands.add('atom-workspace', 'golang:run-tests', () => {
      if (!this.getEditor()) {
        return
      }
      this.runTests()
    }))
    this.subscriptions.add(atom.commands.add('atom-workspace', 'golang:hide-coverage', () => {
      if (!this.getEditor()) {
        return
      }
      this.clearMarkersFromEditors()
    }))
  }

  observeTextEditors () {
    this.subscriptions.add(atom.workspace.observeTextEditors((editor) => {
      this.addMarkersToEditor(editor)
    }))
  }

  observeConfig () {
    this.subscriptions.add(atom.config.observe('go-plus.test.runTestsOnSave', (runTestsOnSave) => {
      if (this.saveSubscriptions) {
        this.saveSubscriptions.dispose()
      }
      this.saveSubscriptions = new CompositeDisposable()
      if (runTestsOnSave) {
        this.subscribeToSaveEvents()
      }
    }))
    this.subscriptions.add(atom.config.observe('go-plus.test.coverageHighlightMode', (coverageHighlightMode) => {
      this.coverageHighlightMode = coverageHighlightMode
    }))
  }

  subscribeToSaveEvents () {
    this.saveSubscriptions.add(atom.workspace.observeTextEditors((editor) => {
      if (!editor || !editor.getBuffer()) {
        return
      }

      const bufferSubscriptions = new CompositeDisposable()
      bufferSubscriptions.add(editor.getBuffer().onDidSave((filePath) => {
        if (atom.config.get('go-plus.test.runTestsOnSave')) {
          this.runTests(editor)
          return
        }
      }))
      bufferSubscriptions.add(editor.getBuffer().onDidDestroy(() => {
        bufferSubscriptions.dispose()
      }))
      this.saveSubscriptions.add(bufferSubscriptions)
    }))
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

  addMarkersToEditors () {
    const editors = atom.workspace.getTextEditors()
    for (const editor of editors) {
      this.addMarkersToEditor(editor)
    }
  }

  clearMarkersFromEditors () {
    const editors = atom.workspace.getTextEditors()
    for (const editor of editors) {
      this.clearMarkers(editor)
    }
  }

  addMarkersToEditor (editor) {
    if (!isValidEditor(editor)) {
      return
    }
    const file = editor.getPath()
    if (!editor.id) {
      return
    }

    if (!file) {
      return
    }
    this.clearMarkers(editor)
    if (!this.ranges || this.ranges.length <= 0) {
      return
    }
    if (this.coverageHighlightMode === 'disabled') {
      return
    }

    const editorRanges = _.filter(this.ranges, (r) => { return _.endsWith(file, r.file.replace(/^_\//g, '')) })

    if (!editorRanges || editorRanges.length <= 0) {
      return
    }

    try {
      const coveredLayer = editor.addMarkerLayer()
      const uncoveredLayer = editor.addMarkerLayer()
      this.markedEditors.set(editor.id, coveredLayer.id + ',' + uncoveredLayer.id)
      for (const range of editorRanges) {
        if (range.count > 0) {
          if (this.coverageHighlightMode === 'covered-and-uncovered' || this.coverageHighlightMode === 'covered') {
            coveredLayer.markBufferRange(range.range, {invalidate: 'touch'})
          }
        } else {
          if (this.coverageHighlightMode === 'covered-and-uncovered' || this.coverageHighlightMode === 'uncovered') {
            uncoveredLayer.markBufferRange(range.range, {invalidate: 'touch'})
          }
        }
      }
      editor.decorateMarkerLayer(coveredLayer, {type: 'highlight', class: 'covered', onlyNonEmpty: true})
      editor.decorateMarkerLayer(uncoveredLayer, {type: 'highlight', class: 'uncovered', onlyNonEmpty: true})
    } catch (e) {
      console.log(e)
    }
  }

  clearMarkers (editor) {
    if (!editor || !editor.id || !editor.getBuffer() || !this.markedEditors) {
      return
    }

    if (!this.markedEditors.has(editor.id)) {
      return
    }

    try {
      const layersid = this.markedEditors.get(editor.id)
      if (!layersid) {
        return
      }

      for (const layerid of layersid.split(',')) {
        const layer = editor.getMarkerLayer(layerid)
        if (layer) {
          layer.destroy()
        }
      }

      this.markedEditors.delete(editor.id)
    } catch (e) {
      console.log(e)
    }
  }

  removeTempDir () {
    if (this.tempDir) {
      rimraf(this.tempDir, (e) => {
        if (e) {
          if (e.handle) {
            e.handle()
          }
          console.log(e)
        }
      })
      this.tempDir = null
    }
  }

  createCoverageFile () {
    this.removeTempDir()
    if (!this.tempDir) {
      this.tempDir = fs.realpathSync(temp.mkdirSync())
    }
    this.coverageFile = path.join(this.tempDir, 'coverage.out')
  }

  projectPath (editor) {
    if (editor && editor.getPath()) {
      return editor.getPath()
    }

    if (atom.project.getPaths().length) {
      return atom.project.getPaths()[0]
    }

    return false
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
    options.cwd = path.dirname(editor.getPath())
    if (this.goconfig) {
      options.env = this.goconfig.environment(o)
    }
    if (!options.env) {
      options.env = process.env
    }
    return options
  }

  runTests (editor = this.getEditor()) {
    if (!isValidEditor(editor)) {
      return Promise.resolve()
    }
    const buffer = editor.getBuffer()
    if (!buffer) {
      return Promise.resolve()
    }
    if (this.running) {
      return Promise.resolve()
    }

    return Promise.resolve().then(() => {
      this.running = true
      this.clearMarkersFromEditors()
      this.createCoverageFile()
      let go = false
      let cover = false
      const locatorOptions = this.getLocatorOptions(editor)
      return this.goconfig.locator.findTool('go', locatorOptions).then((cmd) => {
        if (!cmd) {
          return false
        }
        go = cmd
        return this.goconfig.locator.findTool('cover', locatorOptions)
      }).then((cmd) => {
        if (!cmd) {
          return false
        }
        cover = cmd
      }).then(() => {
        if (!go || !cover) {
          this.running = false
          return
        }

        const cmd = go
        const args = ['test', '-coverprofile=' + this.coverageFile]
        if (atom.config.get('go-plus.test.runTestsWithShortFlag')) {
          args.push('-short')
        }
        if (atom.config.get('go-plus.test.runTestsWithVerboseFlag')) {
          args.push('-v')
        }
        const executorOptions = this.getExecutorOptions(editor)
        this.testPanelManager.update({output: 'Running go ' + args.join(' '), state: 'pending', exitcode: 0})
        return this.goconfig.executor.exec(cmd, args, executorOptions).then((r) => {
          if (!this.testPanelManager) {
            return
          }
          let output = r.stdout
          if (r.stderr && r.stderr.trim() !== '') {
            output = r.stderr + os.EOL + r.stdout
          }

          if (r.exitcode === 0) {
            this.ranges = parser.ranges(this.coverageFile)
            this.addMarkersToEditors()
            this.testPanelManager.update({exitcode: r.exitcode, output: output.trim(), state: 'success'})
          } else {
            this.testPanelManager.update({exitcode: r.exitcode, output: output.trim(), state: 'fail'})
          }

          this.running = false
        })
      }).catch((e) => {
        if (e.handle) {
          e.handle()
        }
        console.log(e)
        this.running = false
        return Promise.resolve()
      })
    })
  }
}
export {Tester}