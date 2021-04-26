import kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { Launcher } from 'comp/launcher';
import { box as tweetnaclBox } from 'tweetnacl';
import { PasswordGenerator } from 'util/generators/password-generator';
import { GeneratorPresets } from 'comp/app/generator-presets';
import { Alerts } from 'comp/ui/alerts';
import { Locale } from 'util/locale';
import { RuntimeInfo } from 'const/runtime-info';
import { KnownAppVersions } from 'const/known-app-versions';
import { ExtensionConnectView } from 'views/extension/extension-connect-view';
import { ExtensionCreateGroupView } from 'views/extension/extension-create-group-view';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { Timeouts } from 'const/timeouts';

const KeeWebAssociationId = 'KeeWeb';
const KeeWebHash = '398d9c782ec76ae9e9877c2321cbda2b31fc6d18ccf0fed5ca4bd746bab4d64a'; // sha256('KeeWeb')

const Errors = {
    noOpenFiles: {
        message: Locale.extensionErrorNoOpenFiles,
        code: '1'
    },
    userRejected: {
        message: Locale.extensionErrorUserRejected,
        code: '6'
    }
};

const connectedClients = new Map();

let logger;
let appModel;
let sendEvent;

function setupListeners() {
    Events.on('file-opened', () => {
        sendEvent({ action: 'database-unlocked' });
    });
    Events.on('one-file-closed', () => {
        if (!appModel.files.hasOpenFiles()) {
            sendEvent({ action: 'database-locked' });
        }
    });
    Events.on('all-files-closed', () => {
        sendEvent({ action: 'database-locked' });
    });
}

function incrementNonce(nonce) {
    // from libsodium/utils.c, like it is in KeePassXC
    let i = 0;
    let c = 1;
    for (; i < nonce.length; ++i) {
        c += nonce[i];
        nonce[i] = c;
        c >>= 8;
    }
}

function getClient(request) {
    if (!request.clientID) {
        throw new Error('Empty clientID');
    }
    const client = connectedClients.get(request.clientID);
    if (!client) {
        throw new Error(`Client not connected: ${request.clientID}`);
    }
    return client;
}

function decryptRequest(request) {
    const client = getClient(request);

    if (!request.nonce) {
        throw new Error('Empty nonce');
    }
    if (!request.message) {
        throw new Error('Empty message');
    }

    const nonce = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    const message = kdbxweb.ByteUtils.base64ToBytes(request.message);

    const data = tweetnaclBox.open(message, nonce, client.publicKey, client.keys.secretKey);

    const json = new TextDecoder().decode(data);
    const payload = JSON.parse(json);

    logger.debug('Extension -> KeeWeb -> (decrypted)', payload);

    if (!payload) {
        throw new Error('Empty request payload');
    }
    if (payload.action !== request.action) {
        throw new Error(`Bad action in decrypted payload`);
    }

    return payload;
}

function encryptResponse(request, payload) {
    logger.debug('KeeWeb -> Extension (decrypted)', payload);

    const nonceBytes = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    incrementNonce(nonceBytes);
    const nonce = kdbxweb.ByteUtils.bytesToBase64(nonceBytes);

    const client = getClient(request);

    payload.nonce = nonce;

    const json = JSON.stringify(payload);
    const data = new TextEncoder().encode(json);

    const encrypted = tweetnaclBox(data, nonceBytes, client.publicKey, client.keys.secretKey);

    const message = kdbxweb.ByteUtils.bytesToBase64(encrypted);

    return {
        action: request.action,
        message,
        nonce
    };
}

function makeError(def) {
    const e = new Error(def.message);
    e.code = def.code;
    return e;
}

function ensureAtLeastOneFileIsOpen() {
    if (!appModel.files.hasOpenFiles()) {
        throw makeError(Errors.noOpenFiles);
    }
}

async function checkContentRequestPermissions(request) {
    if (!appModel.files.hasOpenFiles()) {
        if (AppSettingsModel.extensionFocusIfLocked) {
            try {
                focusKeeWeb();
                await appModel.unlockAnyFile(
                    'extensionUnlockMessage',
                    Timeouts.KeeWebConnectRequest
                );
            } catch {
                throw makeError(Errors.noOpenFiles);
            }
        } else {
            throw makeError(Errors.noOpenFiles);
        }
    }

    const client = getClient(request);
    if (client.permissions) {
        return;
    }

    if (Alerts.alertDisplayed) {
        throw new Error(Locale.extensionErrorAlertDisplayed);
    }

    focusKeeWeb();

    const config = RuntimeDataModel.extensionConnectConfig;
    const files = appModel.files.map((f) => ({
        id: f.id,
        name: f.name,
        checked: !config || config.allFiles || config.files.includes(f.id)
    }));
    if (!files.some((f) => f.checked)) {
        for (const f of files) {
            f.checked = true;
        }
    }

    const extensionName = client.connection.appName
        ? `${client.connection.extensionName} (${client.connection.appName})`
        : client.connection.extensionName;

    const extensionConnectView = new ExtensionConnectView({
        extensionName,
        identityVerified: !Launcher,
        files,
        allFiles: config?.allFiles ?? true,
        askGet: config?.askGet || 'multiple'
    });

    try {
        await alertWithTimeout({
            header: Locale.extensionConnectHeader,
            icon: 'exchange-alt',
            buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
            view: extensionConnectView,
            wide: true,
            opaque: true
        });
    } catch (e) {
        client.permissionsDenied = true;
        Events.emit('browser-extension-sessions-changed');
        throw e;
    }

    RuntimeDataModel.extensionConnectConfig = extensionConnectView.config;
    client.permissions = extensionConnectView.config;
    Events.emit('browser-extension-sessions-changed');
}

function alertWithTimeout(config) {
    return new Promise((resolve, reject) => {
        let inactivityTimer = 0;

        const alert = Alerts.alert({
            ...config,
            success: (res) => {
                clearTimeout(inactivityTimer);
                resolve(res);
            },
            cancel: () => {
                clearTimeout(inactivityTimer);
                reject(makeError(Errors.userRejected));
            }
        });

        inactivityTimer = setTimeout(() => {
            alert.closeWithResult('');
        }, Timeouts.KeeWebConnectRequest);
    });
}

function getAvailableFiles(request) {
    const client = getClient(request);
    if (!client.permissions) {
        return;
    }

    const files = appModel.files.filter(
        (file) =>
            file.active &&
            (client.permissions.allFiles || client.permissions.files.includes(file.id))
    );
    if (!files.length) {
        throw makeError(Errors.noOpenFiles);
    }

    return files;
}

function getVersion(request) {
    return isKeePassXcBrowser(request) ? KnownAppVersions.KeePassXC : RuntimeInfo.version;
}

function isKeeWebConnect(request) {
    return getClient(request).connection.extensionName === 'KeeWeb Connect';
}

function isKeePassXcBrowser(request) {
    return getClient(request).connection.extensionName === 'KeePassXC-Browser';
}

function focusKeeWeb() {
    logger.debug('Focus KeeWeb');
    if (Launcher) {
        Launcher.showMainWindow();
    } else {
        sendEvent({ action: 'attention-required' });
    }
}

const ProtocolHandlers = {
    'ping'({ data }) {
        return { data };
    },

    'change-public-keys'(request, connection) {
        let { publicKey, version, clientID: clientId } = request;

        if (connectedClients.has(clientId)) {
            throw new Error('Changing keys is not allowed');
        }

        if (!Launcher) {
            // on web there can be only one connected client
            connectedClients.clear();
        }

        const keys = tweetnaclBox.keyPair();
        publicKey = kdbxweb.ByteUtils.base64ToBytes(publicKey);

        const stats = {
            connectedDate: new Date(),
            passwordsRead: 0,
            passwordsWritten: 0
        };

        connectedClients.set(clientId, { connection, publicKey, version, keys, stats });

        Events.emit('browser-extension-sessions-changed');

        logger.info('New client key created', clientId, version);

        const nonceBytes = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
        incrementNonce(nonceBytes);
        const nonce = kdbxweb.ByteUtils.bytesToBase64(nonceBytes);

        return {
            action: 'change-public-keys',
            version: getVersion(request),
            publicKey: kdbxweb.ByteUtils.bytesToBase64(keys.publicKey),
            nonce,
            success: 'true',
            ...(isKeeWebConnect(request) ? { appName: 'KeeWeb' } : undefined)
        };
    },

    async 'get-databasehash'(request) {
        decryptRequest(request);

        if (request.triggerUnlock) {
            await checkContentRequestPermissions(request);
        } else {
            ensureAtLeastOneFileIsOpen();
        }

        return encryptResponse(request, {
            hash: KeeWebHash,
            success: 'true',
            version: getVersion(request)
        });
    },

    'generate-password'(request) {
        const password = PasswordGenerator.generate(GeneratorPresets.browserExtensionPreset);

        return encryptResponse(request, {
            version: getVersion(request),
            success: 'true',
            entries: [{ password }]
        });
    },

    'lock-database'(request) {
        decryptRequest(request);
        ensureAtLeastOneFileIsOpen();

        Events.emit('lock-workspace');

        if (Alerts.alertDisplayed) {
            focusKeeWeb();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request)
        });
    },

    'associate'(request) {
        decryptRequest(request);
        ensureAtLeastOneFileIsOpen();

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            id: KeeWebAssociationId
        });
    },

    'test-associate'(request) {
        const payload = decryptRequest(request);
        // ensureAtLeastOneFileIsOpen();

        if (payload.id !== KeeWebAssociationId) {
            throw makeError(Errors.noOpenFiles);
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            id: payload.id
        });
    },

    async 'get-logins'(request) {
        decryptRequest(request);
        await checkContentRequestPermissions(request);

        throw new Error('Not implemented');
    },

    async 'get-totp'(request) {
        decryptRequest(request);
        await checkContentRequestPermissions(request);

        throw new Error('Not implemented');
    },

    async 'set-login'(request) {
        decryptRequest(request);
        await checkContentRequestPermissions(request);

        throw new Error('Not implemented');
    },

    async 'get-database-groups'(request) {
        decryptRequest(request);
        await checkContentRequestPermissions(request);

        const makeGroups = (group) => {
            const res = {
                name: group.title,
                uuid: kdbxweb.ByteUtils.bytesToHex(group.group.uuid.bytes),
                children: []
            };
            for (const subGroup of group.items) {
                if (subGroup.matches()) {
                    res.children.push(makeGroups(subGroup));
                }
            }
            return res;
        };

        const groups = [];
        for (const file of getAvailableFiles(request)) {
            for (const group of file.groups) {
                groups.push(makeGroups(group));
            }
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            groups: { groups }
        });
    },

    async 'create-new-group'(request) {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        if (!payload.groupName) {
            throw new Error('No groupName');
        }

        const groupNames = payload.groupName
            .split('/')
            .map((g) => g.trim())
            .filter((g) => g);

        if (!groupNames.length) {
            throw new Error('Empty group path');
        }

        const files = getAvailableFiles(request);

        for (const file of files) {
            for (const rootGroup of file.groups) {
                let foundGroup = rootGroup;
                const pendingGroups = [...groupNames];
                while (pendingGroups.length && foundGroup) {
                    const title = pendingGroups.shift();
                    foundGroup = foundGroup.items.find((g) => g.title === title);
                }
                if (foundGroup) {
                    return encryptResponse(request, {
                        success: 'true',
                        version: getVersion(request),
                        name: foundGroup.title,
                        uuid: kdbxweb.ByteUtils.bytesToHex(foundGroup.group.uuid.bytes)
                    });
                }
            }
        }

        const createGroupView = new ExtensionCreateGroupView({
            groupPath: groupNames.join(' / '),
            files: files.map((f, ix) => ({ id: f.id, name: f.name, selected: ix === 0 }))
        });

        await alertWithTimeout({
            header: Locale.extensionNewGroupHeader,
            icon: 'folder',
            buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
            view: createGroupView
        });

        const selectedFile = files.find((f) => f.id === createGroupView.selectedFile);

        let newGroup = selectedFile.groups[0];
        const pendingGroups = [...groupNames];

        while (pendingGroups.length) {
            const title = pendingGroups.shift();
            const item = newGroup.items.find((g) => g.title === title);
            if (item) {
                newGroup = item;
            } else {
                newGroup = appModel.createNewGroupWithName(newGroup, selectedFile, title);
            }
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            name: newGroup.title,
            uuid: kdbxweb.ByteUtils.bytesToHex(newGroup.group.uuid.bytes)
        });
    }
};

const ProtocolImpl = {
    init(vars) {
        appModel = vars.appModel;
        logger = vars.logger;
        sendEvent = vars.sendEvent;

        setupListeners();
    },

    cleanup() {
        const wasNotEmpty = connectedClients.size;

        connectedClients.clear();

        if (wasNotEmpty) {
            Events.emit('browser-extension-sessions-changed');
        }
    },

    deleteConnection(connectionId) {
        for (const [clientId, client] of connectedClients.entries()) {
            if (client.connection.connectionId === connectionId) {
                connectedClients.delete(clientId);
            }
        }
        Events.emit('browser-extension-sessions-changed');
    },

    getClientPermissions(clientId) {
        return connectedClients.get(clientId)?.permissions;
    },

    setClientPermissions(clientId, permissions) {
        const client = connectedClients.get(clientId);
        if (client?.permissions) {
            client.permissions = { ...client.permissions, ...permissions };
        }
    },

    errorToResponse(e, request) {
        return {
            action: request?.action,
            error: e.message || 'Unknown error',
            errorCode: e.code || 0
        };
    },

    async handleRequest(request, connectionInfo) {
        const appWindowWasFocused = Launcher?.isAppFocused();

        let result;
        try {
            const handler = ProtocolHandlers[request.action];
            if (!handler) {
                throw new Error(`Handler not found: ${request.action}`);
            }
            result = await handler(request, connectionInfo);
        } catch (e) {
            if (!e.code) {
                logger.error(`Error in handler ${request.action}`, e);
            }
            result = this.errorToResponse(e, request);
        }

        if (!appWindowWasFocused && Launcher?.isAppFocused()) {
            Launcher.hideApp();
        }

        return result;
    },

    get sessions() {
        return [...connectedClients.entries()]
            .map(([clientId, client]) => ({
                clientId,
                connectionId: client.connection.connectionId,
                appName: client.connection.appName,
                extensionName: client.connection.extensionName,
                connectedDate: client.stats.connectedDate,
                passwordsRead: client.stats.passwordsRead,
                passwordsWritten: client.stats.passwordsWritten,
                permissions: client.permissions,
                permissionsDenied: client.permissionsDenied
            }))
            .sort((x, y) => y.connectedDate - x.connectedDate);
    }
};

export { ProtocolImpl };
