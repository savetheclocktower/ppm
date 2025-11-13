
const path = require('path');

const yargs = require('yargs');

const config = require('./apm');
const Command = require('./command');
const fs = require('./fs');

const Arborist = require('@npmcli/arborist');
const runScript = require('@npmcli/run-script');
const nodeGyp = require('node-gyp');
const pacote = require('pacote');
const os = require('os');

const GYP = nodeGyp();

module.exports =
class Rebuild extends Command {
  static commandNames = [ "rebuild" ];

    constructor() {
      super();
      this.atomDirectory = config.getAtomDirectory();
      this.atomNodeDirectory = path.join(this.atomDirectory, '.node-gyp');
      this.atomNpmPath = require.resolve('npm/bin/npm-cli');
    }

    parseOptions(argv) {
      const options = yargs(argv).wrap(Math.min(100, yargs.terminalWidth()));
      options.usage(`\

Usage: ppm rebuild [<name> [<name> ...]]

Rebuild the given modules currently installed in the node_modules folder
in the current working directory.

All the modules will be rebuilt if no module names are specified.\
`
      );
      return options.alias('h', 'help').describe('help', 'Print this usage message');
    }

    // Rebuild a module.
    //
    // Replicates the steps performed by `npm rebuild`.
    //
    // Defined separately from `run` so that other commands can invoke it in
    // isolation.
    async invoke (options) {
      let sharedScriptArgs = {
        path: path.resolve(options.cwd)
      };

      let pack = {};
      let packageJsonPath = path.resolve(options.cwd, 'package.json');
      try {
        pack = JSON.parse(
          fs.readFileSync(
            packageJsonPath,
            'utf8'
          )
        );
      } catch (err) {
        // We can't actually proceed without a parsed package.json here.
        if (err.code === 'ENOENT') {
          throw new Error(`package.json not found: ${packageJsonPath}`);
        } else {
          throw err;
        }
      }

      // Replicate the steps that `npm` performs when it runs `npm rebuild`.

      // First run `preinstall`…
      let preinstall = await runScript({
        event: 'preinstall',
        ...sharedScriptArgs
      });

      let install = null;

      // …then run either an `install` script or `node-gyp rebuild`…
      if (pack.scripts?.install) {
        install = await runScript({
          event: 'install',
          ...sharedScriptArgs
        });
      } else {
        install = await this.forkNodeGypRebuild(options);
      }

      // …then run a `postinstall` script.
      let postinstall = await runScript({
        event: 'postinstall',
        ...sharedScriptArgs
      });

      return {
        preinstall,
        install,
        postinstall
      };
    }

    // Run `node-gyp rebuild` for a particular module.
    async forkNodeGypRebuild (options) {
      if (!options.silent) {
        process.stdout.write('Rebuilding modules ');
      }

      let nodeGypPath = require.resolve('node-gyp/bin/node-gyp');

      const env = {
        ...process.env,
        HOME: this.atomNodeDirectory,
        RUSTUP_HOME: config.getRustupHomeDirPath()
      };

      let allSettings = await config.getAllSettings();
      // TODO: We need to know what settings `npm` or `node-gyp` consulted in
      // the old path so we can make sure we make them available in the new
      // code path.
      env.PYTHON ??= allSettings.python;

      let otherArgs = [];
      if (allSettings.python) {
        env.npm_config_python = allSettings.python;
      }
      if (config.isWin32() && allSettings.msvs_version) {
        env.npm_config_msvs_version = allSettings.msvs_version;
      }
      // env.npm_config_devdir = path.join(this.atomDirectory, '.node-gyp');
      // env.npm_config_nodedir = this.atomNodeDirectory;
      this.addBuildEnvVars(env);

      return new Promise((resolve, reject) => {
        this.fork(
          nodeGypPath,
          ['rebuild', ...otherArgs],
          {
            cwd: options.cwd,
            env
          },
          (code, stderr, stdout) => {
            if (code !== 0) {
              reject(stderr ?? `Unknown error while invoking npm: code ${code}`);
              return;
            }
            resolve({ gyp: true, code, stdout, stderr });
          }
        )
      });
    }

    forkNpmRebuild(options) {
      process.stdout.write('Rebuilding modules ');

      const rebuildArgs = ['--globalconfig', config.getGlobalConfigPath(), '--userconfig', config.getUserConfigPath(), 'rebuild'];
      rebuildArgs.push(...this.getNpmBuildFlags());
      rebuildArgs.push(...options.argv._);

      fs.makeTreeSync(this.atomDirectory);

      const env = {
        ...process.env,
        HOME: this.atomNodeDirectory,
        RUSTUP_HOME: config.getRustupHomeDirPath()
      };
      this.addBuildEnvVars(env);

      return new Promise((resolve, reject) =>
        void this.fork(this.atomNpmPath, rebuildArgs, {env}, (code, stderr) => {
          if (code !== 0) {
            reject(stderr ?? `Unknown error while invoking npm: code ${code}`);
            return;
          }

          resolve();
        })
      );
    }

    async run(options) {
      options = this.parseOptions(options.commandArgs);

      const npm = await config.loadNpm();
      this.npm = npm;
      try {
        await this.loadInstalledAtomMetadata();
        await this.invoke(options);
        // await this.forkNpmRebuild(options);
        this.logSuccess();
      } catch (error) {
        console.log('WTF?', error.message);
        this.logFailure();
        return error; // errors as return values atm
      }
    }
  }
