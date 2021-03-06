'use babel';

// eslint-disable-next-line import/extensions, import/no-extraneous-dependencies
import { CompositeDisposable } from 'atom';
import { dirname, extname } from 'path';

let helpers = null;
let clangFlags = null;
const regex = /(.+):(\d+):(\d+):(?:{(\d+):(\d+)-(\d+):(\d+)}.*:)? ([\w \\-]+): (.*)/g;

export default {
  activate() {
    require('atom-package-deps').install('linter-clang');

    // FIXME: Remove backwards compatibility in a future minor version
    const oldPath = atom.config.get('linter-clang.execPath');
    if (oldPath !== undefined) {
      atom.config.unset('linter-clang.execPath');
      if (oldPath !== 'clang') {
        // If the old config wasn't set to the default migrate it over
        atom.config.set('linter-pylint.executablePath', oldPath);
      }
    }

    this.subscriptions = new CompositeDisposable();
    this.subscriptions.add(
      atom.config.observe('linter-clang.executablePath', (value) => {
        this.executablePath = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe('linter-clang.clangIncludePaths', (value) => {
        this.clangIncludePaths = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe('linter-clang.clangSuppressWarnings', (value) => {
        this.clangSuppressWarnings = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe('linter-clang.clangDefaultCFlags', (value) => {
        this.clangDefaultCFlags = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe('linter-clang.clangDefaultCppFlags', (value) => {
        this.clangDefaultCppFlags = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe('linter-clang.clangDefaultObjCFlags', (value) => {
        this.clangDefaultObjCFlags = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe('linter-clang.clangDefaultObjCppFlags', (value) => {
        this.clangDefaultObjCppFlags = value;
      }),
    );
    this.subscriptions.add(
      atom.config.observe('linter-clang.clangErrorLimit', (value) => {
        this.clangErrorLimit = value;
      }),
    );
  },

  deactivate() {
    this.subscriptions.dispose();
  },

  provideLinter() {
    return {
      name: 'clang',
      scope: 'file',
      lintsOnChange: true,
      grammarScopes: ['source.c', 'source.cpp', 'source.objc', 'source.objcpp'],
      lint: async (editor) => {
        if (helpers === null) {
          helpers = require('atom-linter');
        }
        if (clangFlags === null) {
          clangFlags = require('clang-flags');
        }

        const filePath = editor.getPath();
        if (filePath === undefined) {
          // The editor has no path, meaning it hasn't been saved. Although
          // clang could give us results for this, Linter needs a path
          return [];
        }
        const fileExt = extname(filePath);
        const fileDir = dirname(filePath);
        const fileText = editor.getText();

        const args = [
          '-fsyntax-only',
          '-fno-caret-diagnostics',
          '-fno-diagnostics-fixit-info',
          '-fdiagnostics-print-source-range-info',
          '-fexceptions',
          `-ferror-limit=${this.clangErrorLimit}`,
        ];

        // Non-Public API!
        const grammar = editor.getGrammar().name;

        switch (grammar) {
          case 'Objective-C':
            args.push('-xobjective-c');
            args.push(...this.clangDefaultObjCFlags.split(/\s+/));
            break;
          case 'Objective-C++':
            args.push('-xobjective-c++');
            args.push(...this.clangDefaultObjCppFlags.split(/\s+/));
            break;
          case 'C':
            args.push('-xc');
            args.push(...this.clangDefaultCFlags.split(/\s+/));
            break;
          default:
          case 'C++':
          case 'C++14':
            args.push('-xc++');
            args.push(...this.clangDefaultCppFlags.split(/\s+/));
            break;
        }

        if (fileExt === '.hpp' || fileExt === '.hh' || fileExt === '.h') {
          // Don't warn about #pragma once when linting header files
          args.push('-Wno-pragma-once-outside-header');
        }

        if (this.clangSuppressWarnings) {
          args.push('-w');
        }

        if (atom.inDevMode()) {
          args.push('--verbose');
        }

        this.clangIncludePaths.forEach(path =>
          args.push(`-I${path}`),
        );

        try {
          const flags = clangFlags.getClangFlags(filePath);
          if (flags) {
            args.push(...flags);
          }
        } catch (error) {
          if (atom.inDevMode()) {
            // eslint-disable-next-line no-console
            console.log(error);
          }
        }

        args.push('-');

        const execOpts = {
          stdin: fileText,
          stream: 'stderr',
          allowEmptyStderr: true,
          cwd: fileDir,
        };

        const output = await helpers.exec(this.executablePath, args, execOpts);

        if (editor.getText() !== fileText) {
          // Editor contents have changed, tell Linter not to update results
          // eslint-disable-next-line no-console
          console.warn('linter-clang: Editor contents changed, not updating results');
          return null;
        }

        const toReturn = [];
        let match = regex.exec(output);

        while (match !== null) {
          let position;
          if (match[4] !== undefined) {
            const lineStart = Number.parseInt(match[4], 10) - 1;
            const colStart = Number.parseInt(match[5], 10) - 1;
            const lineEnd = Number.parseInt(match[6], 10) - 1;
            const colEnd = Number.parseInt(match[7], 10) - 1;
            position = [[lineStart, colStart], [lineEnd, colEnd]];
          } else {
            const line = Number.parseInt(match[2], 10) - 1;
            const col = Number.parseInt(match[3], 10) - 1;
            position = helpers.generateRange(editor, line, col);
          }
          const severity = /error/.test(match[8]) ? 'error' : 'warning';
          // Handle paths other than the file being linted still
          const file = match[1] === '<stdin>' ? filePath : match[1];
          toReturn.push({
            severity,
            location: { file, position },
            excerpt: match[9],
          });
          match = regex.exec(output);
        }

        return toReturn;
      },
    };
  },
};
