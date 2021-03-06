'use babel'

import {CompositeDisposable} from 'atom'

class ToolChecker {
  constructor (goconfigFunc, gogetFunc) {
    this.goget = gogetFunc
    this.goconfig = goconfigFunc
    this.subscriptions = new CompositeDisposable()
  }

  dispose () {
    if (this.subscriptions) {
      this.subscriptions.dispose()
    }
    this.subscriptions = null
  }

  checkForTools (tools) {
    if (!tools || !tools.length) {
      return
    }
    let shouldUpdateTools = false
    const promises = []
    for (const tool of tools) {
      if (!tool) {
        continue
      }
      const options = {env: this.goconfig().environment()}
      promises.push(this.goconfig().locator.findTool(tool, options).then((cmd) => {
        if (!cmd) {
          shouldUpdateTools = true
        }
      }))
    }
    Promise.all(promises).then(() => {
      if (!shouldUpdateTools) {
        return
      }

      atom.commands.dispatch(atom.views.getView(atom.workspace), 'golang:update-tools')
    })
  }
}

export {ToolChecker}
