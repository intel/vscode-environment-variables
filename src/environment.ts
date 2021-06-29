/**
 * Copyright (c) Intel Corporation
 * Licensed under the MIT License. See the project root LICENSE
 * 
 * SPDX-License-Identifier: MIT
 */

'use strict';
import * as vscode from 'vscode';
import * as terminal_utils from './utils/terminal_utils';
import { execSync, exec } from 'child_process';
import { posix, join, parse } from 'path';
import { existsSync } from 'fs';
import { Storage } from './utils/storage_utils';

export abstract class OneApiEnv {
    protected collection: vscode.EnvironmentVariableCollection;
    protected initialEnv: Map<string, string | undefined>;
    protected activeEnv: string;
    protected statusBarItem: vscode.StatusBarItem;

    private _setvarsConfigsPaths: string[] | undefined;
    private _oneAPIRootPath: string | undefined;

    public set setvarsConfigsPaths(configsPaths: string[] | undefined) {
        if (configsPaths?.length === 0 || configsPaths === undefined) {
            this._setvarsConfigsPaths = undefined;
        } else {
            configsPaths.forEach(async function (onePath, index, pathList) {
                pathList[index] = posix.normalize(onePath.replace(`\r`, "")).split(/[\\\/]/g).join(posix.sep);
            });
            this._setvarsConfigsPaths = configsPaths;
        }
    }

    public set oneAPIRootPath(rootPath: string | undefined) {
        if (rootPath?.length === 0 || rootPath === undefined) {
            this._oneAPIRootPath = undefined;
        } else {
            this._oneAPIRootPath = posix.normalize(rootPath.replace(`\r`, "")).split(/[\\\/]/g).join(posix.sep);
        }
    }

    constructor(context: vscode.ExtensionContext) {
        this.initialEnv = new Map();
        this.activeEnv = "Undefined";
        this.collection = context.environmentVariableCollection;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right);
        this.setupVscodeEnv();
        this.setEnvNameToStatusBar(undefined);
        context.subscriptions.push(vscode.window.onDidOpenTerminal((terminal: vscode.Terminal) => {
            if (context.environmentVariableCollection.get('SETVARS_COMPLETED')) {
                let extraTerminalName = 'Intel';
                if (this.activeEnv !== "Undefined") {
                    extraTerminalName = this.activeEnv;
                }
                vscode.commands.executeCommand('workbench.action.terminal.renameWithArg', { name: `${extraTerminalName} oneAPI: ${terminal.name}` });
            }
        }));
    }

    abstract initializeDefaultEnvironment(): Promise<void>;
    abstract initializeCustomEnvironment(): Promise<void>;
    abstract clearEnvironment(): void;
    abstract switchEnv(): Promise<boolean>;

    protected async getEnvironment(isDefault: boolean): Promise<boolean | undefined> {
        const setvarsPath = await this.findSetvarsPath();
        if (!setvarsPath) {
            vscode.window.showInformationMessage(`Could not find path to setvars.${process.platform === 'win32' ? 'bat' : 'sh'} or the path was not selected. Provide it yourself.`);
            const options: vscode.OpenDialogOptions = {
                canSelectMany: false,
                filters: {
                    'oneAPI setvars file': [process.platform === 'win32' ? 'bat' : 'sh'],
                }
            };

            const setVarsFileUri = await vscode.window.showOpenDialog(options);
            if (setVarsFileUri && setVarsFileUri[0]) {
                return await this.runSetvars(setVarsFileUri[0].fsPath, isDefault);
            } else {
                vscode.window.showErrorMessage(`Path to setvars.${process.platform === 'win32' ? 'bat' : 'sh'} invalid, The oneAPI environment was not be applied.\n Please check setvars.${process.platform === 'win32' ? 'bat' : 'sh'} and try again.`, { modal: true });
                return false;
            }
        } else {
            vscode.window.showInformationMessage(`oneAPI environment script was found in the following path: ${setvarsPath}`);
            return await this.runSetvars(setvarsPath, isDefault);

        }
    }

    private async getSetvarsConfigPath(): Promise<string | undefined> {
        if (this._setvarsConfigsPaths) {
            const options: vscode.InputBoxOptions = {
                placeHolder: `Please select which configuration file you want to use:`
            };
            const optinosItems: vscode.QuickPickItem[] = [];
            this._setvarsConfigsPaths.forEach(async function (onePath) {
                optinosItems.push({
                    label: parse(onePath).base,
                    description: onePath
                });
            });
            optinosItems.push({
                label: 'Skip',
                description: 'Do not apply the configuration file'
            });
            const tmp = await vscode.window.showQuickPick(optinosItems, options);
            if (!tmp || tmp?.label === 'Skip') {
                return undefined;
            }
            if (tmp?.description) {
                if (!existsSync(tmp?.description)) {
                    vscode.window.showErrorMessage(`Could not find the ${tmp?.label} file on the path ${tmp?.description} .  To fix this problem, go to the extension settings and specify the correct path for SETVARS_CONFIG`);
                }
                return tmp?.description;
            }
        }
        return undefined;
    }

    private async findSetvarsPath(): Promise<string | undefined> {
        try {
            // 0. Check oneAPI Root Path from setting.json
            if (this._oneAPIRootPath) {
                const pathToSetvars = join(this._oneAPIRootPath, `setvars.${process.platform === 'win32' ? 'bat' : 'sh'}`);
                if (existsSync(pathToSetvars)) {
                    return pathToSetvars;
                } else {
                    vscode.window.showErrorMessage('Could not find setvars script by the path specified for ONEAPI_ROOT in the settings. You can ignore this problem and continue with the setvars automatic search, or if it fails, specify the location manually. To fix this problem, go to the extension settings and specify the correct path for ONEAPI_ROOT.');
                    const options: vscode.InputBoxOptions = {
                        placeHolder: `Could not find setvars at the path specified in ONEAPI_ROOT`
                    };
                    const optinosItems: vscode.QuickPickItem[] = [];
                    optinosItems.push({
                        label: 'Continue',
                        description: 'Try to find setvars automatically'
                    });
                    optinosItems.push({
                        label: 'Skip setvars search',
                        description: 'Allows to go directly to specifying the path to setvars'
                    });

                    const tmp = await vscode.window.showQuickPick(optinosItems, options);
                    if (tmp?.label !== 'Continue') {
                        return undefined;
                    }
                }
            }
            // 1.check $PATH for setvars.sh
            const cmdParsePath = process.platform === 'win32' ?
                `pwsh -Command "$env:Path -split ';' | Select-String -Pattern 'oneapi$' | foreach{$_.ToString()} | ? {$_.trim() -ne '' }"` :
                "env | grep 'PATH' | sed 's/'PATH='//g; s/:/\\n/g'| awk '/oneapi$/'";
            const paths = execSync(cmdParsePath).toString().split('\n');
            paths.pop();
            paths.forEach(async function (onePath, index, pathList) {
                pathList[index] = posix.normalize(onePath.replace(`\r`, "")).split(/[\\\/]/g).join(posix.sep);
            });

            if (paths.length > 0 && paths.length !== 1) {
                const options: vscode.InputBoxOptions = {
                    placeHolder: `Found multiple paths to oneAPI environment script. Choose which one to use:`
                };
                const tmp = await vscode.window.showQuickPick(paths, options);
                if (!tmp) {
                    return undefined;
                }
                return tmp;

            } else {
                if (paths.length === 1) {
                    return join(paths[0], `setvars.${process.platform === 'win32' ? 'bat' : 'sh'}`);
                }
            }
            // 2.check in $ONEAPI_ROOT
            if (existsSync(`${process.env.ONEAPI_ROOT}/setvars.${process.platform === 'win32' ? 'bat' : 'sh'}`)) {
                return `${process.env.ONEAPI_ROOT}/setvars.${process.platform === 'win32' ? 'bat' : 'sh'}`;
            }
            // 3.check in global installation path
            const globalSetvarsPath = process.platform === 'win32' ?
                `${process.env['ProgramFiles(x86)']}\\Intel\\oneAPI\\setvars.bat` :
                '/opt/intel/oneapi/setvars.sh';
            if (existsSync(globalSetvarsPath)) {
                return globalSetvarsPath;
            }
            if (process.platform !== 'win32') {
                {
                    // 4.check in local installation path
                    if (existsSync(`${process.env.HOME}/intel/oneapi/setvars.sh`)) {
                        return `${process.env.HOME}/intel/oneapi/setvars.sh`;
                    }
                    //5.check in local-custom installation path
                    //Path does not require normalization because it is generated only for Linux
                    const paths = execSync("find \"${HOME}\" -mindepth 3 -maxdepth 3 -name \"setvars.sh\"").toString().split('\n');
                    paths.pop();
                    if (paths.length > 0 && paths.length !== 1) {
                        const options: vscode.InputBoxOptions = {
                            placeHolder: `Found multiple paths to oneAPI environment script. Choose which one to use:`
                        };
                        const tmp = await vscode.window.showQuickPick(paths, options);
                        if (tmp) {
                            return tmp;
                        }
                    } else {
                        if (paths.length === 1) {
                            return paths[0];
                        }
                    }
                }
            }
            return undefined;
        }
        catch (err) {
            console.error(err);
            return undefined;
        }
    }

    private async runSetvars(fspath: string, isDefault: boolean): Promise<boolean> {
        let args = '';
        if (!isDefault) {
            const setvarsConfigPath = await this.getSetvarsConfigPath();
            if (setvarsConfigPath) {
                this.activeEnv = parse(setvarsConfigPath).base;
                vscode.window.showInformationMessage(`The config file found in ${setvarsConfigPath} is used`);
                args = `--config="${setvarsConfigPath}"`;
            } else {
                this.activeEnv = "Default";
            }
        }
        const cmd = process.platform === 'win32' ?
            `"${fspath}" ${args} > NULL && set` :
            `bash -c ". ${fspath} ${args}  > /dev/null && env -0"`;

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "Setting up oneAPI environment...",
            cancellable: true
        }, async (_progress, token) => {
            token.onCancellationRequested(() => {
                this.collection.clear();
                return false; // if user click on CANCEL
            });
            await this.execSetvarsCatch(token, cmd);
        });

        await terminal_utils.checkExistingTerminals();
        return true;
    }

    private async execSetvarsCatch(token: vscode.CancellationToken, cmd: string): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            if (token.isCancellationRequested) {
                this.collection.clear();
                return;
            }
            const childProcess = exec(cmd)
                .on("close", (code, signal) => {
                    if (code || signal) {
                        this.collection.clear();
                        vscode.window.showErrorMessage(`Something went wrong! \n Error: ${code ? code : signal}. oneAPI environment not applied.`, { modal: true });
                    }
                    resolve();
                })
                .on("error", (err) => {
                    this.collection.clear();
                    vscode.window.showErrorMessage(`Something went wrong! \n Error: ${err} oneAPI environment not applied.`, { modal: true });
                    reject(err);
                });
            childProcess.stdout?.on("data", (d: string) => {
                const separator = process.platform === 'win32' ? '\n' : '\u0000';
                const vars = d.split(separator);
                vars.forEach(async (l) => {
                    const e = l.indexOf('=');
                    const k = <string>l.substr(0, e);
                    const v = <string>l.substr((e + 1)).replace(`\r`, "");

                    if (k === "" || v === "") {
                        return;
                    }

                    if (process.env[k] !== v) {
                        if (!process.env[k]) {
                            this.collection.append(k, v);
                        } else {
                            this.collection.replace(k, v);
                        }
                    }
                    process.env[k] = v;
                });
            });
            token.onCancellationRequested(() => childProcess.kill());
        });
    }

    private setupVscodeEnv(): void {
        Object.keys(process.env).forEach((k) => {
            this.initialEnv.set(k, process.env[k] as string);
        });
        this.collection.forEach((v, m) => {
            process.env[v] = m.value;
        });
        return;
    }

    protected async restoreVscodeEnv(): Promise<void> {
        this.collection.forEach((k) => {
            const oldVarValue = this.initialEnv.get(k);
            if (!oldVarValue) {
                delete process.env[k];
            } else {
                process.env[k] = oldVarValue;
            }
        });
        return;
    }

    protected setEnvNameToStatusBar(envName: string | undefined): void {
        if (envName) {
            this.statusBarItem.text = "Active environment: ".concat(envName);
        }
        else {
            this.statusBarItem.text = "Active environment: ".concat("not selected");
        }
        this.statusBarItem.show();
    }
}



export class MultiRootEnv extends OneApiEnv {
    private storage: Storage;
    private envCollection: string[];

    constructor(context: vscode.ExtensionContext) {
        super(context);
        this.storage = new Storage(context.workspaceState);
        this.envCollection = [];
        this.setEnvNameToStatusBar(undefined);
        this.updateEnvsInStorage();
    }

    async initializeDefaultEnvironment(): Promise<void> {
        this.initializeEnvironment(true);
    }

    async initializeCustomEnvironment(): Promise<void> {
        this.initializeEnvironment(false);
    }
    async initializeEnvironment(isDefault: boolean): Promise<void> {
        if (this.initialEnv.get("SETVARS_COMPLETED")) {
            await vscode.window.showWarningMessage("OneAPI environment has already been initialized outside of the configurator. There is no guarantee that the environment management features will work correctly. It is recommended to run Visual Studio Code without prior oneAPI product environment initialization.", { modal: true });
            return;
        }

        if (await this.getEnvironment(isDefault)) {
            if (!this.envCollection.includes(this.activeEnv)) {
                this.envCollection.push(this.activeEnv);
            }
            else {
                vscode.window.showInformationMessage(`Environment ${this.activeEnv} was redefined`);
            }
            const activeEnvCollection = new Map();
            this.collection.forEach((k, m) => {
                activeEnvCollection.set(k, m.value);
            });
            await this.storage.writeEnvToExtensionStorage(this.activeEnv, activeEnvCollection);

        }
    }

    async clearEnvironment(): Promise<void> {
        await this.restoreVscodeEnv();
        await this.removeEnv(this.activeEnv);
        this.activeEnv = 'Undefined';
        vscode.window.showInformationMessage("oneAPI environment removed successfully.");
        return;
    }

    async switchEnv(): Promise<boolean> {
        const optinosItems: vscode.QuickPickItem[] = [];
        const options: vscode.InputBoxOptions = {
            placeHolder: `Please select which setvars_config file you want to set:`
        };
        this.envCollection.forEach(async function (oneEnv) {
                optinosItems.push({
                    label: oneEnv,
                    description: oneEnv === "Default" ? "Initialize the default environment" : `To initialize the environment using the ${oneEnv} file`
                });
        });
        optinosItems.push({
            label: 'Skip',
            description: 'Do not change the environment'
        });
        const env = await vscode.window.showQuickPick(optinosItems, options);
        if (!env || env?.label === 'Skip') {
            return false;
        }
        this.setEnvNameToStatusBar(env.label);
        await this.applyEnv(env.label);
        return true;
    }

    private async addEnv(env: string | undefined): Promise<void> {
        await this.storage.writeEnvToExtensionStorage(env, new Map());
    }

    private async removeEnv(env: string): Promise<void> {
        //this.storage.writeEnvToExtensionStorage(env, new Map());
        await this.storage.set(env, undefined);
        this.collection.clear();
        await this.storage.writeEnvToExtensionStorage(env, undefined);
        this.setEnvNameToStatusBar(undefined);
    }

    private async applyEnv(folder: string): Promise<boolean> {
        this.restoreVscodeEnv();
        this.collection.clear();
        const env = await this.storage.readEnvFromExtensionStorage(folder);
        if (!env || env.size === 0) {
            return false;
        }
        for (const keyValuePair of env) {
            this.collection.append(keyValuePair[0], keyValuePair[1]);
            process.env[keyValuePair[0]] = keyValuePair[1];
        }
        return true;
    }

    private async updateEnvsInStorage(): Promise<void> {
        const env = await this.storage.readEnvFromExtensionStorage(this.activeEnv);
        if (!env) {
            await this.addEnv(this.activeEnv);
        }
    }
}
