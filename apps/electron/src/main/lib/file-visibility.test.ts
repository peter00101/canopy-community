import { describe, expect, test } from 'bun:test'
import { isPythonEnvironmentDirName, isTransientFileName } from './file-visibility'

describe('文件面板可见性 · 临时 / 锁文件', () => {
  test('给定 Office / WPS / LibreOffice 的锁文件与 .tmp，当判定时，则都算临时文件', () => {
    for (const name of ['~$报告.docx', '~$ta.xlsx', '.~lock.报告.docx#', 'ckpt-12.tmp', '~WRL0001.TMP']) {
      expect(isTransientFileName(name)).toBe(true)
    }
  })

  test('给定名字相近的正常文件，当判定时，则不误伤', () => {
    for (const name of ['报告.docx', 'template.md', '$HOME.txt', 'a~$b.docx', '.~lock.docx', 'tmp', 'notes.tmpl', 'temp.py']) {
      expect(isTransientFileName(name)).toBe(false)
    }
  })
})

describe('文件面板可见性 · Python 虚拟环境目录', () => {
  test('给定带后缀的虚拟环境与 site-packages，当判定时，则都算虚拟环境', () => {
    for (const name of ['.venv', 'venv', '.venv-train', 'venv_gpu', '.venv.bak', 'venv310', 'VENV', 'site-packages']) {
      expect(isPythonEnvironmentDirName(name)).toBe(true)
    }
  })

  test('给定以 venv 开头但不是虚拟环境的普通目录，当判定时，则不误伤', () => {
    for (const name of ['venue', 'venvironment', 'events', '.vscode', 'env', 'my-venv', 'packages']) {
      expect(isPythonEnvironmentDirName(name)).toBe(false)
    }
  })
})
