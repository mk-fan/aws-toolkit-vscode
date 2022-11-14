/*!
 * Copyright 2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import globals from '../shared/extensionGlobals'

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import { selectCodeCatalystResource } from './wizards/selectResource'
import { openCodeCatalystUrl } from './utils'
import { CodeCatalystAuthenticationProvider } from './auth'
import { Commands } from '../shared/vscode/commands2'
import {
    CodeCatalystClient,
    ConnectedCodeCatalystClient,
    CodeCatalystResource,
} from '../shared/clients/codecatalystClient'
import { createClientFactory, DevEnvironmentId, getConnectedDevEnv, getRepoCloneUrl, openDevEnv } from './model'
import { showConfigureDevEnv } from './vue/configure/backend'
import { showCreateDevEnv } from './vue/create/backend'
import { CancellationError } from '../shared/utilities/timeoutUtils'
import { ToolkitError } from '../shared/errors'
import { telemetry } from '../shared/telemetry/telemetry'
import { showConfirmationMessage } from '../shared/utilities/messages'
import { AccountStatus } from '../shared/telemetry/telemetryClient'
import { CreateDevEnvironmentRequest } from '../../types/clientcodecatalyst'

/** "List CodeCatalyst Commands" command. */
export async function listCommands(): Promise<void> {
    vscode.commands.executeCommand('workbench.action.quickOpen', '> CodeCatalyst')
}

/** "Clone CodeCatalyst Repository" command. */
export async function cloneCodeCatalystRepo(client: ConnectedCodeCatalystClient, url?: vscode.Uri): Promise<void> {
    async function getPat() {
        // FIXME: make it easier to go from auth -> client so we don't need to do this
        const auth = CodeCatalystAuthenticationProvider.fromContext(globals.context)
        return auth.getPat(client)
    }

    let resource: { name: string; project: string; org: string }
    if (!url) {
        const r = await selectCodeCatalystResource(client, 'repo')
        if (!r) {
            throw new CancellationError('user')
        }
        resource = { name: r.name, project: r.project.name, org: r.org.name }
    } else {
        const [_, org, project, repo] = url.path.slice(1).split('/')
        if (!org || !project || !repo) {
            throw new Error(`Invalid CodeCatalyst URL: unable to parse repository`)
        }
        resource = { name: repo, project, org }
    }

    const uri = await getRepoCloneUrl(
        client,
        {
            spaceName: resource.org,
            projectName: resource.project,
            sourceRepositoryName: resource.name,
        },
        client.identity.name,
        await getPat()
    )
    await vscode.commands.executeCommand('git.clone', uri)
}

/**
 * Implements commands:
 * - "Open CodeCatalyst Space"
 * - "Open CodeCatalyst Project"
 * - "Open CodeCatalyst Repository"
 */
export async function openCodeCatalystResource(
    client: ConnectedCodeCatalystClient,
    kind: CodeCatalystResource['type']
): Promise<void> {
    const resource = await selectCodeCatalystResource(client, kind)

    if (!resource) {
        throw new CancellationError('user')
    }

    openCodeCatalystUrl(resource)
}

export async function stopDevEnv(
    client: ConnectedCodeCatalystClient,
    devenv: DevEnvironmentId,
    opts?: { readonly showPrompt?: boolean }
): Promise<void> {
    if (opts?.showPrompt) {
        const confirmed = await showConfirmationMessage({
            prompt: localize(
                'aws.codecatalyst.stopDevEnv.confirm',
                'Stopping the dev environment will end all processes. Continue?'
            ),
        })

        if (!confirmed) {
            throw new CancellationError('user')
        }
    }

    await client.stopDevEnvironment({
        id: devenv.id,
        projectName: devenv.project.name,
        spaceName: devenv.org.name,
    })
}

export async function deleteDevEnv(client: ConnectedCodeCatalystClient, devenv: DevEnvironmentId): Promise<void> {
    await client.deleteDevEnvironment({
        id: devenv.id,
        projectName: devenv.project.name,
        spaceName: devenv.org.name,
    })
}

export type DevEnvironmentSettings = Pick<
    CreateDevEnvironmentRequest,
    'alias' | 'instanceType' | 'inactivityTimeoutMinutes' | 'persistentStorage'
>

export async function updateDevEnv(
    client: ConnectedCodeCatalystClient,
    devenv: DevEnvironmentId,
    settings: DevEnvironmentSettings
) {
    return client.updateDevEnvironment({
        ...settings,
        id: devenv.id,
        projectName: devenv.project.name,
        spaceName: devenv.org.name,
    })
}

function createClientInjector(
    authProvider: CodeCatalystAuthenticationProvider,
    clientFactory: () => Promise<CodeCatalystClient>
): ClientInjector {
    return async (command, ...args) => {
        const client = await clientFactory()

        try {
            if (!client.connected) {
                throw new ToolkitError('Not connected to CodeCatalyst', { code: 'NoConnection' })
            }

            return await command(client, ...args)
        } finally {
            const userId = client.connected ? `codecatalyst;${client.identity.id}` : AccountStatus.NotApplicable

            // TODO(sijaden): should this mark only instantiated spans or future spans as well?
            // right now it won't mark spans if they're created and emitted prior to the command finishing
            telemetry.record({ userId })
        }
    }
}

function createCommandDecorator(commands: CodeCatalystCommands): CommandDecorator {
    return command =>
        (...args) =>
            commands.withClient(command, ...args)
}

interface CodeCatalystCommand<T extends any[], U> {
    (client: ConnectedCodeCatalystClient, ...args: T): U | Promise<U>
}

interface ClientInjector {
    <T extends any[], U>(command: CodeCatalystCommand<T, U>, ...args: T): Promise<U | undefined>
}

interface CommandDecorator {
    <T extends any[], U>(command: CodeCatalystCommand<T, U>): (...args: T) => Promise<U | undefined>
}

type Inject<T, U> = T extends (...args: infer P) => infer R
    ? P extends [U, ...infer L]
        ? (...args: L) => R
        : never
    : never

type WithClient<T> = Parameters<Inject<T, ConnectedCodeCatalystClient>>

export class CodeCatalystCommands {
    public readonly withClient: ClientInjector
    public readonly bindClient = createCommandDecorator(this)

    public constructor(
        authProvider: CodeCatalystAuthenticationProvider,
        clientFactory = createClientFactory(authProvider)
    ) {
        this.withClient = createClientInjector(authProvider, clientFactory)
    }

    public listCommands() {
        return listCommands()
    }

    public cloneRepository(...args: WithClient<typeof cloneCodeCatalystRepo>) {
        return this.withClient(cloneCodeCatalystRepo, ...args)
    }

    public createDevEnv(): Promise<void> {
        return this.withClient(showCreateDevEnv, globals.context, CodeCatalystCommands.declared)
    }

    public openResource(...args: WithClient<typeof openCodeCatalystResource>) {
        return this.withClient(openCodeCatalystResource, ...args)
    }

    public stopDevEnv(...args: WithClient<typeof stopDevEnv>) {
        return this.withClient(stopDevEnv, ...args).then(() => {
            vscode.commands.executeCommand('workbench.action.remote.close')
        })
    }

    public deleteDevEnv(...args: WithClient<typeof deleteDevEnv>) {
        return this.withClient(deleteDevEnv, ...args)
    }

    public updateDevEnv(...args: WithClient<typeof updateDevEnv>) {
        telemetry.codecatalyst_updateWorkspaceSettings.record({ codecatalyst_updateWorkspaceLocationType: 'remote' })

        return this.withClient(updateDevEnv, ...args)
    }

    public openSpace() {
        return this.openResource('org')
    }

    public openProject() {
        return this.openResource('project')
    }

    public openRepository() {
        return this.openResource('repo')
    }

    public async openDevfile(uri: vscode.Uri) {
        await vscode.window.showTextDocument(uri)
    }

    public async openDevEnv(id?: DevEnvironmentId, targetPath?: string): Promise<void> {
        if (vscode.env.remoteName === 'ssh-remote') {
            throw new ToolkitError('Cannot connect from a remote context. Try again from a local VS Code instance.', {
                code: 'ConnectedToRemote',
            })
        }

        const devenv = id ?? (await this.selectDevEnv())

        // TODO(sijaden): add named timestamp markers for granular duration info
        //
        // right now this command may prompt the user if they came from the explorer or command palette
        // need to be careful of mapping explosion so this granular data would either need
        // to be flattened or we restrict the names to a pre-determined set
        if (id === undefined) {
            telemetry.codecatalyst_connect.record({ source: 'CommandPalette' })
        }

        return this.withClient(openDevEnv, devenv, targetPath)
    }

    public async openDevEnvSettings(): Promise<void> {
        const devenv = await this.withClient(getConnectedDevEnv)

        if (!devenv) {
            throw new Error('No devenv available')
        }

        return this.withClient(showConfigureDevEnv, globals.context, devenv, CodeCatalystCommands.declared)
    }

    private async selectDevEnv(): Promise<DevEnvironmentId> {
        const devenv = await this.withClient(selectCodeCatalystResource, 'devEnvironment' as const)

        if (!devenv) {
            throw new CancellationError('user')
        }

        return devenv
    }

    public static fromContext(ctx: Pick<vscode.ExtensionContext, 'secrets' | 'globalState'>) {
        const auth = CodeCatalystAuthenticationProvider.fromContext(ctx)
        const factory = createClientFactory(auth)

        return new this(auth, factory)
    }

    public static readonly declared = {
        openResource: Commands.from(this).declareOpenResource('aws.codecatalyst.openResource'),
        listCommands: Commands.from(this).declareListCommands('aws.codecatalyst.listCommands'),
        openSpace: Commands.from(this).declareOpenSpace('aws.codecatalyst.openOrg'),
        openProject: Commands.from(this).declareOpenProject('aws.codecatalyst.openProject'),
        openRepository: Commands.from(this).declareOpenRepository('aws.codecatalyst.openRepo'),
        stopDevEnv: Commands.from(this).declareStopDevEnv('aws.codecatalyst.stopDevEnv'),
        deleteDevEnv: Commands.from(this).declareDeleteDevEnv('aws.codecatalyst.deleteDevEnv'),
        openDevEnvSettings: Commands.from(this).declareOpenDevEnvSettings('aws.codecatalyst.openDevEnvSettings'),
        openDevfile: Commands.from(this).declareOpenDevfile('aws.codecatalyst.openDevfile'),
        cloneRepo: Commands.from(this).declareCloneRepository({
            id: 'aws.codecatalyst.cloneRepo',
            telemetryName: 'codecatalyst_localClone',
        }),
        createDevEnv: Commands.from(this).declareCreateDevEnv({
            id: 'aws.codecatalyst.createDevEnv',
            telemetryName: 'codecatalyst_createWorkspace',
        }),
        updateDevEnv: Commands.from(this).declareUpdateDevEnv({
            id: 'aws.codecatalyst.updateDevEnv',
            telemetryName: 'codecatalyst_updateWorkspaceSettings',
        }),
        openDevEnv: Commands.from(this).declareOpenDevEnv({
            id: 'aws.codecatalyst.openDevEnv',
            telemetryName: 'codecatalyst_connect',
        }),
    } as const
}