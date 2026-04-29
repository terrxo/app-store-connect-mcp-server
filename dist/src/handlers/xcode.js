import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, statSync } from 'fs';
const execFileAsync = promisify(execFile);
export class XcodeHandlers {
    async listSchemes(args) {
        const { projectPath } = args;
        if (!projectPath) {
            throw new Error('Project path is required');
        }
        if (!existsSync(projectPath)) {
            throw new Error(`Project path does not exist: ${projectPath}`);
        }
        const stats = statSync(projectPath);
        if (!stats.isDirectory()) {
            throw new Error(`Project path is not a directory: ${projectPath}`);
        }
        const isWorkspace = projectPath.endsWith('.xcworkspace');
        const isProject = projectPath.endsWith('.xcodeproj');
        if (!isWorkspace && !isProject) {
            throw new Error('Project path must be either a .xcworkspace or .xcodeproj file');
        }
        try {
            const args = isWorkspace
                ? ['-workspace', projectPath, '-list']
                : ['-project', projectPath, '-list'];
            const { stdout, stderr } = await execFileAsync('xcodebuild', args);
            if (stderr && stderr.trim() !== '') {
                console.error('xcodebuild stderr:', stderr);
            }
            const schemes = this.parseXcodebuildOutput(stdout);
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify({
                            projectPath,
                            projectType: isWorkspace ? 'workspace' : 'project',
                            schemes,
                            totalSchemes: schemes.length
                        }, null, 2)
                    }
                ]
            };
        }
        catch (error) {
            throw new Error(`Failed to list schemes: ${error.message}`);
        }
    }
    parseXcodebuildOutput(output) {
        const lines = output.split('\n');
        const schemes = [];
        let inSchemesSection = false;
        for (const line of lines) {
            const trimmedLine = line.trim();
            if (trimmedLine === 'Schemes:') {
                inSchemesSection = true;
                continue;
            }
            if (inSchemesSection) {
                if (trimmedLine === '' || trimmedLine.startsWith('Build Configurations:') || trimmedLine.startsWith('If no build configuration')) {
                    break;
                }
                if (trimmedLine && !trimmedLine.startsWith('Information about project')) {
                    const isShared = !trimmedLine.startsWith('    ');
                    const schemeName = trimmedLine.trim();
                    if (schemeName) {
                        schemes.push({
                            name: schemeName,
                            isShared
                        });
                    }
                }
            }
        }
        return schemes;
    }
}
