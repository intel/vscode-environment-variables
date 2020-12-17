import * as vscode from 'vscode';
import * as child_process from 'child_process';
import * as fs from 'fs';

const debugConfig = {
    'name': 'bla',
    'type': 'cppdbg',
    'request': 'launch',
    'program': '${workspaceFolder}/${workspaceFolderBasename}',
    'args': [],
    'stopAtEntry': false,
    'cwd': '${workspaceFolder}',
    'environment': [],
    'externalConsole': false,
    "envFile": "${workspaceFolder}/oneAPI.env",
    'MIMode': 'gdb',
    'setupCommands':
        [
            {
                'description': 'Enable pretty-printing for gdb',
                'text': '-enable-pretty-printing',
                'ignoreFailures': true,
            }
        ]
};

export class DevFlow {
    terminal: vscode.Terminal;
    constructor() {
        this.terminal = vscode.window.createTerminal();
    }
    async setEnvironment(): Promise<void> {
        if (!fs.existsSync(`${vscode.workspace.rootPath}/oneAPI.env`)) {
            await vscode.window.showInformationMessage('Provide path to oneAPI setvars.sh.', 'select').then(async selection => {
                if (selection === 'select') {
                    const options: vscode.OpenDialogOptions = {
                        canSelectMany: false,
                        openLabel: 'Select',
                        filters: {
                            'oneAPI setvars file': ['sh'],
                        }
                    };
                    await vscode.window.showOpenDialog(options).then(fileUri => {
                        if (fileUri && fileUri[0]) {
                            this.terminal.sendText(`source ${fileUri[0].fsPath}`);
                            // create environment file
                            this.terminal.sendText(`env > oneAPI.env`);
                        }
                    });
                }
            });
        }
    }
    runExtension(): void {
        const tasks: vscode.QuickPickItem[] = [{ label: 'Generate Developer Flow' }];
        this.setEnvironment().then(async () => {
            await vscode.window.showQuickPick(tasks).then(async selection => {
                if (!selection) {
                    return;
                }
                switch (selection.label) {
                    case 'Generate Developer Flow':
                        await this.makeTasksFile();
                        if (!fs.existsSync(`${vscode.workspace.rootPath}/.vscode/launch.json`)) {
                            await this.makeLaunchFile();
                        }
                        break;
                    default:
                        break;
                }
            });
        });

    }
    async makeTasksFile(): Promise<void> {
        let buildSystem: string = 'cmake';
        let buildDir: string = `${vscode.workspace.rootPath}`;
        if (fs.existsSync(`${vscode.workspace.rootPath}/Makefile`)) {
            buildSystem = 'make';
        }
        const buildTargets = await this.getTargets(buildDir, buildSystem);

        await vscode.window.showQuickPick(buildTargets).then(async selection => {
            if (!selection) {
                return;
            }
            const launchConfig = vscode.workspace.getConfiguration('tasks');
            let taskConfigValue = {
                label: selection,
                command: `sed -e's/$/"/' ${vscode.workspace.rootPath}/oneAPI.env | sed -e's/=/="/' > tmp && set -a && source tmp && set +a && rm tmp `,
                type: 'shell',
                options: {
                    cwd: `${buildDir}`
                }
            };
            switch (buildSystem) {
                case 'make': {
                    taskConfigValue.command += `&& make ${selection} -f ${buildDir}/Makefile`;
                    break;
                }
                case 'cmake': {
                    taskConfigValue.command += `&& mkdir -p build && cmake -S . -B build && cmake --build build && cmake --build build --target ${selection}`;
                    break;
                }
                default: {
                    break;
                }
            }
            let config: any = launchConfig['tasks'];
            if (config === undefined) {
                config = [taskConfigValue];
            } else {
                config.push(taskConfigValue);
            };
            launchConfig.update('tasks', config, false);
        });
    }
    makeLaunchFile(): void {
        const launchConfig = vscode.workspace.getConfiguration('launch');
        const configurations = launchConfig['configurations'];
        configurations.push(debugConfig);
        launchConfig.update('configurations', configurations, false);
        return;

    }
    async getTargets(buildDirPath: string, buildSystem: string): Promise<string[]> {
        let targets: string[];
        switch (buildSystem) {
            case 'make': {
                targets = child_process.execSync(
                    `make -pRrq : 2>/dev/null | awk -v RS= -F: '/^# File/,/^# Finished Make data base/ {if ($1 !~ "^[#.]") {print $1}}' | egrep -v '^[^[:alnum:]]' | sort`,
                    { cwd: buildDirPath }).toString().split('\n');
                targets.pop();
                return targets;
            }
            case 'cmake': {
                targets = ['all', 'clean'];
                let pathsToCmakeLists: string[] = child_process.execSync(`find ${vscode.workspace.rootPath} -name 'CMakeLists.txt'`).toString().split('\n');
                pathsToCmakeLists.forEach((path) => {
                    targets = targets.concat(child_process.execSync(
                        `awk '/^add_custom_target/' ${path} | sed -e's/add_custom_target(/ /' | awk '{print $1}'`,
                        { cwd: buildDirPath }).toString().split('\n'));
                    targets.pop();
                });
                return targets;
            }
            default: {
                break;
            }
        }
        return [];
    }
}