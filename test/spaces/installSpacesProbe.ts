/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Installs the Spaces validation probe into an extensions directory.
//
// Usage: node test/spaces/installSpacesProbe.ts [extensionsDir]
// Default extensionsDir: ~/.vscode-oss-dev/extensions (the dev build's default)

import * as fs from 'fs';
import { stripTypeScriptTypes } from 'module';
import * as os from 'os';
import * as path from 'path';

const sourceDir = path.join(import.meta.dirname, 'spaces-probe');
const extensionsDir = path.resolve(process.argv[2] ?? path.join(os.homedir(), '.vscode-oss-dev', 'extensions'));

const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8'));
const targetDir = path.join(extensionsDir, `${manifest.publisher}.${manifest.name}-${manifest.version}`);

fs.rmSync(targetDir, { recursive: true, force: true });
fs.mkdirSync(targetDir, { recursive: true });

fs.copyFileSync(path.join(sourceDir, 'package.json'), path.join(targetDir, 'package.json'));
fs.writeFileSync(path.join(targetDir, 'extension.js'), stripTypeScriptTypes(fs.readFileSync(path.join(sourceDir, 'extension.ts'), 'utf8')));

console.log(`Installed ${manifest.publisher}.${manifest.name} into ${targetDir}`);
