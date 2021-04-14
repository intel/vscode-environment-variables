/**
 * Copyright (c) Intel Corporation
 * Licensed under the MIT License. See the project root LICENSE
 * 
 * SPDX-License-Identifier: MIT
 */

'use strict';
import * as vscode from 'vscode';
import { execSync } from 'child_process';
import { posix, join, parse, normalize } from 'path';
import { existsSync } from 'fs';

const debugConfig = {
    name: '(gdb-oneapi) ${workspaceFolderBasename} Launch',
    type: 'cppdbg',
    request: 'launch',
    preLaunchTask: '',
    postDebugTask: '',
    program: '',
    args: [],
    stopAtEntry: false,
    cwd: '${workspaceFolder}',
    environment: [],
    externalConsole: false,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    MIMode: 'gdb',
    miDebuggerPath: 'gdb-oneapi',
    setupCommands:
        [
            {
                description: 'Enable pretty-printing for gdb',
                text: '-enable-pretty-printing',
                ignoreFailures: true
            }
        ]
};
export class LaunchConfigurator {
    private collection: vscode.EnvironmentVariableCollection;
    constructor(collection: vscode.EnvironmentVariableCollection) {
        this.collection = collection;
    }

    async makeTasksFile(): Promise<boolean> {
        let buildSystem = 'cmake';
        let workspaceFolder = await getworkspaceFolder();
        if (!workspaceFolder) {
            return false; // for unit tests
        }
        let projectRootDir = `${workspaceFolder?.uri.fsPath}`;
        if (existsSync(`${projectRootDir}/Makefile`)) {
            if (process.platform === 'win32') {
                vscode.window.showInformationMessage(`Working with makefile project is not available for Windows.`, { modal: true });
                return false;
            }
            buildSystem = 'make';
        }
        const buildTargets = await this.getTargets(projectRootDir, buildSystem);
        let isContinue = true;
        let options: vscode.InputBoxOptions = {
            placeHolder: `Choose target from ${buildSystem} or push ESC for exit`
        };
        do {
            let selection = await vscode.window.showQuickPick(buildTargets, options);
            if (!selection) {
                isContinue = false;
                return true;
            }
            const taskConfig = vscode.workspace.getConfiguration('tasks');
            let taskConfigValue = {
                label: selection,
                command: ``,
                type: 'shell',
                options: {
                    cwd: `${projectRootDir}`.split(/[\\\/]/g).join(posix.sep)
                }
            };
            switch (buildSystem) {
                case 'make': {
                    let cmd = process.platform === 'win32' ?
                        `nmake ${selection} /F ${projectRootDir}/Makefile` :
                        `make ${selection} -f ${projectRootDir}/Makefile`;
                    taskConfigValue.command += cmd;
                    break;
                }
                case 'cmake': {
                    let cmd = process.platform === 'win32' ?
                        `$val=Test-Path -Path 'build'; if($val -ne $true) {New-Item -ItemType directory -Path 'build'}; cmake  -S . -B 'build' -G 'NMake Makefiles'; cd build; nmake ${selection}` :
                        `mkdir -p build && cmake  -S . -B build && cmake --build build && cmake --build build --target ${selection}`;
                    taskConfigValue.command += cmd;
                    break;
                }
                default: {
                    isContinue = false;
                    break;
                }
            }
            let config: any = taskConfig['tasks'];
            if (!config) {
                config = [taskConfigValue];
            } else {
                let isUniq: boolean = await this.checkTaskItem(config, taskConfigValue);
                if (!isUniq) {
                    vscode.window.showInformationMessage(`Task for "${taskConfigValue.label}" was skipped as duplicate`);
                    return false;
                }
                config.push(taskConfigValue);
            };
            taskConfig.update('tasks', config, false);
            vscode.window.showInformationMessage(`Task for "${taskConfigValue.label}" was added`);
        } while (isContinue);
        return true;
    }

    async makeLaunchFile(): Promise<boolean> {
        if (!this.collection.get('SETVARS_COMPLETED')) {
            vscode.window.showErrorMessage("Failed to generate launch configurations. Make sure oneAPI environment is set.");
            return false;
        };
        let oneAPIDir = this.collection.get("ONEAPI_ROOT")?.value;
        if (!oneAPIDir) {
            vscode.window.showErrorMessage("Could not find environment variable ONEAPI_ROOT. Make sure oneAPI environment is set.");
            return false;
        }
        let buildSystem = 'cmake';
        let workspaceFolder = await getworkspaceFolder();
        if (!workspaceFolder) {
            return false; // for unit tests
        }
        let projectRootDir = `${workspaceFolder?.uri.fsPath}`;
        if (existsSync(`${projectRootDir}/Makefile`)) {
            buildSystem = 'make';
        }
        let execFiles: string[] = [];
        let execFile;
        switch (buildSystem) {
            case 'make': {
                execFiles = await this.findExecutables(projectRootDir);
                break;
            }
            case 'cmake': {
                execFiles = await this.findExecutables(projectRootDir);
                if (execFiles.length === 0) {
                    let execNames = await this.getExecNameFromCmake(projectRootDir);
                    execNames.forEach(async (name: string) => {
                        execFiles.push(join(`${projectRootDir}`, `build`, `src`, name));
                    });
                    if (execFiles.length !== 0) {
                        vscode.window.showInformationMessage(`Could not find executable files.\nThe name of the executable will be taken from CMakeLists.txt, and the executable is expected to be located in /build/src.`);
                    }
                }

                break;
            }
            default: {
                break;
            }
        }
        execFiles.push(`Put temporal target path "a.out" to replace it later with correct path manually`);
        execFiles.push(`Provide path to the executable file manually`);
        let isContinue = true;
        let options: vscode.InputBoxOptions = {
            placeHolder: `Choose executable target or push ESC for exit`
        };
        do {
            let selection = await vscode.window.showQuickPick(execFiles, options);
            if (!selection) {
                isContinue = false;
                break;
            }
            if (selection === `Put temporal target path "a.out" to replace it later with correct path manually`) {
                selection = 'a.out';
                await vscode.window.showInformationMessage(`Note: Launch template cannot be launched immediately after creation.\nPlease edit the launch.json file according to your needs before run.`, { modal: true });

            }
            if (selection === `Provide path to the executable file manually`) {
                const options: vscode.OpenDialogOptions = {
                    canSelectMany: false
                };
                let pathToExecFile = await vscode.window.showOpenDialog(options);
                if (pathToExecFile && pathToExecFile[0]) {
                    execFile = pathToExecFile[0].fsPath;
                } else {
                    await vscode.window.showErrorMessage(`Path to the executable file invalid.\nPlease check path and name and try again.`, { modal: true });
                    return false;
                }
            } else {
                execFile = selection;
            }

            const launchConfig = vscode.workspace.getConfiguration('launch');
            const configurations = launchConfig['configurations'];

            debugConfig.name = selection === 'a.out' ?
                `Launch_template` :
                `(gdb-oneapi) ${parse(execFile).base} Launch`;
            debugConfig.program = `${execFile}`.split(/[\\\/]/g).join(posix.sep);
            let pathToGDB = join(oneAPIDir, 'debugger', 'latest', 'gdb', 'intel64', 'bin', process.platform === 'win32' ? 'gdb-oneapi.exe' : 'gdb-oneapi');
            //This is the only known way to replace \\ with /
            debugConfig.miDebuggerPath = posix.normalize(pathToGDB).split(/[\\\/]/g).join(posix.sep);
            await this.addTasksToLaunchConfig();
            let isUniq: boolean = await this.checkLaunchItem(configurations, debugConfig);
            if (isUniq) {
                configurations.push(debugConfig);
                launchConfig.update('configurations', configurations, false);
                vscode.window.showInformationMessage(`Launch configuration "${debugConfig.name}" for "${debugConfig.program}" was added`);
            } else {
                vscode.window.showInformationMessage(`Launch configuration "${debugConfig.name}" for "${debugConfig.program}" was skipped as duplicate`);
                return false;
            }
        } while (isContinue);
        vscode.window.showWarningMessage(`At the moment, debugging is only available on the CPU and FPGA_Emu accelerators.\nOperation on other types of accelerators is not guaranteed.`, { modal: true });
        return true;
    }

    private async checkTaskItem(listItems: any, newItem: any): Promise<boolean> {
        if (listItems.length === 0) {
            return true; // for tests
        }
        restartcheck:
        for (var existItem in listItems) {
            let dialogOptions: string[] = [`Skip target`, `Rename task`];
            if (newItem.label === listItems[existItem].label) {
                let options: vscode.InputBoxOptions = {
                    placeHolder: `Task for target "${newItem.label}" already exist. Do you want to rename current task or skip target?`
                };
                let selection = await vscode.window.showQuickPick(dialogOptions, options);
                if (!selection || selection === `Skip target`) {
                    return false;
                }
                else {
                    let inputBoxText: vscode.InputBoxOptions = {
                        placeHolder: "Please provide new task name:"
                    };
                    let inputLabel = await vscode.window.showInputBox(inputBoxText);
                    newItem.label = inputLabel;
                    continue restartcheck;
                }
            }
        }
        return true;
    }

    private async checkLaunchItem(listItems: any, newItem: any): Promise<boolean> {
        if (listItems.length === 0) {
            return true; // for tests
        }
        restartcheck:
        for (var existItem in listItems) {
            let dialogOptions: string[] = [`Skip target`, `Rename configuration`];
            if (newItem.name === listItems[existItem].name) {
                let options: vscode.InputBoxOptions = {
                    placeHolder: `Launch configuration for target "${newItem.name}" already exist. Do you want to rename current configuration or skip target?`
                };
                let selection = await vscode.window.showQuickPick(dialogOptions, options);
                if (!selection || selection === `Skip target `) {
                    return false;
                }
                else {
                    let inputBoxText: vscode.InputBoxOptions = {
                        placeHolder: "Please provide new configuration name:"
                    };
                    let inputName = await vscode.window.showInputBox(inputBoxText);
                    newItem.name = inputName;
                    continue restartcheck;
                }
            }
        }
        return true;
    }

    private async addTasksToLaunchConfig(): Promise<boolean> {
        const taskConfig = vscode.workspace.getConfiguration('tasks');
        let existTasks: any = taskConfig['tasks'];
        let tasksList: string[] = [];
        for (var task in existTasks) {
            tasksList.push(existTasks[task].label);
        }
        tasksList.push('Skip adding preLaunchTask');
        let preLaunchTaskOptions: vscode.InputBoxOptions = {
            placeHolder: `Choose task for adding to preLaunchTask`
        };
        let preLaunchTask = await vscode.window.showQuickPick(tasksList, preLaunchTaskOptions);
        if (preLaunchTask && preLaunchTask !== 'Skip adding preLaunchTask') {
            debugConfig.preLaunchTask = preLaunchTask;
        }
        tasksList.pop();
        let postDebugTaskOptions: vscode.InputBoxOptions = {
            placeHolder: `Choose task for adding to postDebugTask`
        };
        tasksList.push('Skip adding postDebugTask');
        let postDebugTask = await vscode.window.showQuickPick(tasksList, postDebugTaskOptions);
        if (postDebugTask && postDebugTask !== 'Skip adding postDebugTask') {
            debugConfig.postDebugTask = postDebugTask;
        }
        return true;
    }

    private async findExecutables(projectRootDir: string): Promise<string[]> {
        try {
            const cmd = process.platform === 'win32' ?
                `pwsh -command "Get-ChildItem '${projectRootDir}' -recurse -Depth 3 -include '*.exe' -Name | ForEach-Object -Process {$execPath='${projectRootDir}' +'\\'+ $_;echo $execPath}"` :
                `find ${projectRootDir} -maxdepth 3 -exec file {} \\; | grep -i elf | cut -f1 -d ':'`;
            let pathsToExecutables = execSync(cmd).toString().split('\n');
            pathsToExecutables.pop();
            pathsToExecutables.forEach(async function (onePath, index, execList) {
                //This is the only known way to replace \\ with /
                execList[index] = posix.normalize(onePath.replace('\r', '')).split(/[\\\/]/g).join(posix.sep);
            });
            return pathsToExecutables;
        }
        catch (err) {
            console.log(err);
            return [];
        }
    }

    private async getExecNameFromCmake(projectRootDir: string): Promise<string[]> {
        try {
            let execNames: string[] = [];
            let cmd = process.platform === 'win32' ?
                `where /r ${projectRootDir} CMakeLists.txt` :
                `find ${projectRootDir} -name 'CMakeLists.txt'`;
            let pathsToCmakeLists = execSync(cmd).toString().split('\n');
            pathsToCmakeLists.pop();
            pathsToCmakeLists.forEach(async (onePath) => {
                let normalizedPath = normalize(onePath.replace(`\r`, "")).split(/[\\\/]/g).join(posix.sep);
                let cmd = process.platform === 'win32' ?
                    `pwsh -Command "$execNames=(gc ${normalizedPath}) | Select-String -Pattern '\\s*add_executable\\s*\\(\\s*(\\w*)' ; $execNames.Matches | ForEach-Object -Process {echo $_.Groups[1].Value} | Select-Object -Unique | ? {$_.trim() -ne '' } "` :
                    `awk '/^ *add_executable *\\( *[^\$]/' ${normalizedPath} | sed -e's/add_executable *(/ /; s/\\r/ /' | awk '{print $1}' | uniq`;
                execNames = execNames.concat(execSync(cmd, { cwd: projectRootDir }).toString().split('\n'));
                execNames.pop();
                execNames.forEach(async function (oneExec, index, execList) {
                    execList[index] = normalize(oneExec.replace(`\r`, "")).split(/[\\\/]/g).join(posix.sep);
                });
            });

            return execNames;
        }
        catch (err) {
            console.error(err);
            return [];
        }
    }

    private async getTargets(projectRootDir: string, buildSystem: string): Promise<string[]> {
        try {
            let targets: string[];
            switch (buildSystem) {
                case 'make': {
                    targets = execSync(
                        `make -pRrq : 2>/dev/null | awk -v RS= -F: '/^# File/,/^# Finished Make data base/ {if ($1 !~ "^[#.]") {print $1}}' | egrep -v '^[^[:alnum:]]' | sort`,
                        { cwd: projectRootDir }).toString().split('\n');
                    targets.pop();
                    return targets;
                }
                case 'cmake': {
                    targets = ['all', 'clean'];

                    let cmd = process.platform === 'win32' ?
                        `where /r ${projectRootDir} CMakeLists.txt` :
                        `find ${projectRootDir} -name 'CMakeLists.txt'`;
                    let pathsToCmakeLists = execSync(cmd).toString().split('\n');
                    pathsToCmakeLists.pop();
                    pathsToCmakeLists.forEach(async (onePath) => {
                        let normalizedPath = normalize(onePath.replace(`\r`, "")).split(/[\\\/]/g).join(posix.sep);
                        let cmd = process.platform === 'win32' ?
                            `pwsh -Command "$targets=(gc ${normalizedPath}) | Select-String -Pattern '\\s*add_custom_target\\s*\\(\\s*(\\w*)' ; $targets.Matches | ForEach-Object -Process {echo $_.Groups[1].Value} | Select-Object -Unique | ? {$_.trim() -ne '' } "` :
                            `awk '/^ *add_custom_target/' ${normalizedPath} | sed -e's/add_custom_target *(/ /; s/\\r/ /' | awk '{print $1}' | uniq`;
                        targets = targets.concat(execSync(cmd, { cwd: projectRootDir }).toString().split('\n'));
                        targets.pop();
                        targets.forEach(async function (oneTarget, index, targetList) {
                            targetList[index] = posix.normalize(oneTarget.replace(`\r`, ""));
                        });
                    });
                    return targets;
                }
                default: {
                    break;
                }
            }
            return [];
        }
        catch (err) {
            console.error(err);
            return [];
        }
    };
}

async function getworkspaceFolder(): Promise<vscode.WorkspaceFolder | undefined> {
    if (vscode.workspace.workspaceFolders?.length === 1) {
        return vscode.workspace.workspaceFolders[0];
    }
    let selection = await vscode.window.showWorkspaceFolderPick();
    if (!selection) {
        vscode.window.showErrorMessage("Cannot find the working directory!", { modal: true });
        vscode.window.showInformationMessage("Please add one or more working directories and try again.");
        return undefined; // for unit tests
    }
    return selection;
}