import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { EventEmitter } from 'events';
import pino, { Logger } from 'pino'
import makeWASocket, {
    DisconnectReason,
    fetchLatestBaileysVersion,
    getAggregateVotesInPollMessage,
    makeCacheableSignalKeyStore,

    useMultiFileAuthState,
    Browsers,
    proto,
    WAMessageContent,
    WAMessageKey
} from '@whiskeysockets/baileys'
import { readFileSync, existsSync, rmSync } from 'fs';

import ffmpeg from 'fluent-ffmpeg';

import mime from 'mime-types';
import { join } from 'path';



interface Args {
    debug?: boolean;
    [key: string]: any;  // Define the shape of this object as needed
}

type SendMessageOptions = {
    keyword?: string,
    refresh?: string,
    answer?: string,
    options: {
        capture?: boolean
        child?: any
        delay?: number
        nested?: any[]
        keyword?: any
        callback?: boolean
        buttons?: { body: string }[]
        media?: string
    },
    refSerialize?: string,
    quoted?: any
}

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg')

// const msgRetryCounterCache = new NodeCache()

export class BaileysClass extends EventEmitter {
    private isStopped: boolean = false;
    private vendor: any;
    private store: any;
    private globalVendorArgs: Args;
    private sock: any;
    private NAME_DIR_SESSION: string;
    private plugin: boolean;


    constructor(args = {}) {

        super()
        this.vendor = null;
        this.store = null;
        this.globalVendorArgs = { name: `bot`, usePairingCode: false, phoneNumber: null, gifPlayback: false, dir: './', ...args };
        this.NAME_DIR_SESSION = `${this.globalVendorArgs.dir}${this.globalVendorArgs.name}_sessions`;
        this.initBailey();

        // is plugin?
        const err = new Error();
        const stack = err.stack;
        this.plugin = stack?.includes('createProvider') ?? false;

    }

    getMessage = async (key: WAMessageKey): Promise<WAMessageContent | undefined> => {
        if (this.store) {
            const msg = await this.store.loadMessage(key.remoteJid, key.id)
            return msg?.message || undefined
        }
        // only if store is present
        return proto.Message.fromObject({})
    }

    getInstance = (): any => this.vendor;

    initBailey = async (): Promise<void> => {
        if (this.isStopped) return;
        const logger: Logger = pino({ level: this.globalVendorArgs.debug ? 'debug' : 'fatal' })
        const { state, saveCreds } = await useMultiFileAuthState(this.NAME_DIR_SESSION);
        const { version, isLatest } = await fetchLatestBaileysVersion()

        if (this.globalVendorArgs.debug) console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

        setInterval(() => {
            const path = `${this.NAME_DIR_SESSION}/baileys_store.json`;
            if (existsSync(path)) {
                this.store.writeToFile(path);
            }
        }, 10_000);

        try {
            this.setUpBaileySock({ version, logger, state, saveCreds });
        } catch (e) {
            this.emit('auth_failure', e);
        }
    }


    setUpBaileySock = async ({
        version,
        logger,
        state,
        saveCreds,
    }: {
        version: [number, number, number],
        logger: Logger,
        state: any,
        saveCreds: () => Promise<void>
    }) => {
        this.sock = makeWASocket({
            version,
            logger,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            browser: Browsers.macOS('Desktop'),
            generateHighQualityLinkPreview: true,
            getMessage: this.getMessage,
        })

        this.store?.bind(this.sock.ev)

        if (this.globalVendorArgs.usePairingCode) {
            if (this.globalVendorArgs.phoneNumber) {
                await this.sock.waitForConnectionUpdate((update: any) => !!update.qr)
                const code = await this.sock.requestPairingCode(this.globalVendorArgs.phoneNumber)
                if (this.plugin) {
                    this.emit('require_action', {
                        instructions: [
                            `Acepta la notificación del WhatsApp ${this.globalVendorArgs.phoneNumber} en tu celular 👌`,
                            `El token para la vinculación es: ${code}`,
                            `Necesitas ayuda: https://link.codigoencasa.com/DISCORD`,
                        ],
                    })
                } else {
                    this.emit('pairing_code', code);
                }
            } else {
                this.emit('auth_failure', 'phoneNumber is empty')
            }
        }

        this.sock.ev.on('connection.update', this.handleConnectionUpdate);
        this.sock.ev.on('creds.update', saveCreds)

        this.sock.ev.on('messages.upsert', async (m: any) => {
            this.emit('messages.upsert', m.messages);
        });

        this.sock.ev.on('chats.upsert', ({ chats }: { chats: any[] }) => {
            this.emit('chats.upsert', chats);
        });

        this.sock.ev.on('chats.update', async (updates: any) => {
            this.emit('chats.update', updates);

        });
        this.sock.ev.on('messages.update', async (updates: any) => {
            this.emit('messages.update', updates);
        });

    }

    handleConnectionUpdate = async (update: any): Promise<void> => {
        const { connection, lastDisconnect, qr } = update;
        const statusCode = lastDisconnect?.error?.output?.statusCode;

        if (this.isStopped) {
            if (this.sock) {
                try { await this.sock.logout(); } catch { }
            }
            return;
        }

        if (connection === 'close') {
            console.log(statusCode)
            if (statusCode !== DisconnectReason.loggedOut) this.initBailey();
            if (statusCode === DisconnectReason.loggedOut) {
                this.clearSession();
                this.emit('disconnected', { code: statusCode, reason: lastDisconnect?.error?.message });
                console.log('disconnect');
            };
        }

        if (connection === 'open') {
            this.vendor = this.sock;
            this.initBusEvents(this.sock);
            this.emit('ready', true);
        }

        if (qr && !this.globalVendorArgs.usePairingCode) {
            if (this.plugin) {
                this.emit('require_action', {
                    instructions: [
                        `Debes escanear el QR Code 👌 ${this.globalVendorArgs.name}.qr.png`,
                        `Recuerda que el QR se actualiza cada minuto `,
                        `Necesitas ayuda: https://link.codigoencasa.com/DISCORD`,
                    ],
                });
            }
            if (!this.isStopped) {
                this.emit('qr', qr);
                if (this.plugin) await UtilsBaileys.baileyGenerateImage(qr, `${this.globalVendorArgs.name}.qr.png`);
            }
        }
    }

    clearSessionAndRestart = (): void => {
        const PATH_BASE = join(process.cwd(), this.NAME_DIR_SESSION);
        rmSync(PATH_BASE, { recursive: true, force: true });
        this.initBailey();
    }

    clearSession = (): void => {
        const PATH_BASE = join(process.cwd(), this.NAME_DIR_SESSION);
        rmSync(PATH_BASE, { recursive: true, force: true });
    }

    busEvents = (): any[] => [
        {
            event: 'messages.upsert',
            func: ({ messages, type }: { messages: any[]; type: string }) => {
                // Ignore notify messages
                if (type !== 'notify') return

                const [messageCtx] = messages;
                let payload = {
                    ...messageCtx,
                    body: messageCtx?.message?.extendedTextMessage?.text ?? messageCtx?.message?.conversation,
                    from: messageCtx?.key?.remoteJid,
                    type: 'text'
                };

                // Ignore pollUpdateMessage
                if (messageCtx.message?.pollUpdateMessage) return

                // Ignore broadcast messages
                if (payload.from === 'status@broadcast') return

                // Ignore messages from self
                if (payload?.key?.fromMe) return

                // Detect location
                if (messageCtx.message?.locationMessage) {
                    const { degreesLatitude, degreesLongitude } = messageCtx.message.locationMessage;
                    if (typeof degreesLatitude === 'number' && typeof degreesLongitude === 'number') {
                        payload = { ...payload, body: UtilsBaileys.generateRefprovider('_event_location_'), type: 'location' };
                    }
                }
                // Detect  media
                if (messageCtx.message?.imageMessage) {
                    payload = { ...payload, body: UtilsBaileys.generateRefprovider('_event_media_'), type: 'image' };
                }

                // Detect  ectar file
                if (messageCtx.message?.documentMessage) {
                    payload = { ...payload, body: UtilsBaileys.generateRefprovider('_event_document_'), type: 'file' };
                }

                // Detect voice note
                if (messageCtx.message?.audioMessage) {
                    payload = { ...payload, body: UtilsBaileys.generateRefprovider('_event_voice_note_'), type: 'voice' };
                }

                // Check from user and group is valid 
                if (!UtilsBaileys.formatPhone(payload.from)) {
                    return
                }

                const btnCtx = payload?.message?.buttonsResponseMessage?.selectedDisplayText;
                if (btnCtx) payload.body = btnCtx;

                const listRowId = payload?.message?.listResponseMessage?.title;
                if (listRowId) payload.body = listRowId;

                payload.from = UtilsBaileys.formatPhone(payload.from, this.plugin);
                this.emit('message', payload);
            },
        },
        {
            event: 'messages.update',
            func: async (message: any[]) => {
                for (const { key, update } of message) {
                    if (update.pollUpdates) {
                        const pollCreation = await this.getMessage(key)
                        if (pollCreation) {
                            const pollMessage = await getAggregateVotesInPollMessage({
                                message: pollCreation,
                                pollUpdates: update.pollUpdates,
                            })
                            const [messageCtx] = message;

                            let payload = {
                                ...messageCtx,
                                body: pollMessage.find(poll => poll.voters.length > 0)?.name || '',
                                from: UtilsBaileys.formatPhone(key.remoteJid, this.plugin),
                                voters: pollCreation,
                                type: 'poll'
                            };

                            this.emit('message', payload);
                        }
                    }
                }
            }
        }
    ]

    initBusEvents = (_sock: any): void => {
        this.vendor = _sock;
        const listEvents = this.busEvents();

        for (const { event, func } of listEvents) {
            this.vendor.ev.on(event, func);
        }
    }

    /**
     * Send Media
     * @alpha
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'https://dominio.com/imagen.jpg' | 'img/imagen.jpg')
     */

    sendMedia = async (number: string, mediaUrl: string, text: string): Promise<any> => {
        try {
            const fileDownloaded = await UtilsBaileys.generalDownload(mediaUrl);
            const mimeType = mime.lookup(fileDownloaded);

            if (typeof mimeType === 'string' && mimeType.includes('image')) return this.sendImage(number, fileDownloaded, text);
            if (typeof mimeType === 'string' && mimeType.includes('video')) return this.sendVideo(number, fileDownloaded, text);
            if (typeof mimeType === 'string' && mimeType.includes('audio')) {
                const fileOpus = await UtilsBaileys.convertAudio(fileDownloaded);
                return this.sendAudio(number, fileOpus);
            }

            return this.sendFile(number, fileDownloaded)
        } catch (error) {
            console.error(`Error enviando media: ${error}`);
            throw error;
        }
    }

    /**
     * Send image
     * @param {*} number
     * @param {*} filePath
     * @param {*} text
     * @returns
     */
    sendImage = async (number: string, filePath: string, text: string): Promise<any> => {
        const numberClean = UtilsBaileys.formatPhone(number)
        return this.vendor.sendMessage(numberClean, {
            image: readFileSync(filePath),
            caption: text ?? '',
        })
    }

    /**
     * Enviar video
     * @param {*} number
     * @param {*} imageUrl
     * @param {*} text
     * @returns
     */
    sendVideo = async (number: string, filePath: string, text: string): Promise<any> => {
        const numberClean = UtilsBaileys.formatPhone(number)
        return this.vendor.sendMessage(numberClean, {
            video: readFileSync(filePath),
            caption: text,
            gifPlayback: this.globalVendorArgs.gifPlayback,
        })
    }

    /**
     * Enviar audio
     * @alpha
     * @param {string} number
     * @param {string} message
     * @param {boolean} voiceNote optional
     * @example await sendMessage('+XXXXXXXXXXX', 'audio.mp3')
     */

    sendAudio = async (number: string, audioUrl: string): Promise<any> => {
        const numberClean = UtilsBaileys.formatPhone(number)
        return this.vendor.sendMessage(numberClean, {
            audio: { url: audioUrl },
            ptt: true,
        })
    }

    /**
     *
     * @param {string} number
     * @param {string} message
     * @returns
     */
    sendText = async (number: string, message: string): Promise<any> => {
        const numberClean = UtilsBaileys.formatPhone(number)
        return this.vendor.sendMessage(numberClean, { text: message })
    }

    /**
     *
     * @param {string} number
     * @param {string} filePath
     * @example await sendMessage('+XXXXXXXXXXX', './document/file.pdf')
     */

    sendFile = async (number: string, filePath: string): Promise<any> => {
        const numberClean = UtilsBaileys.formatPhone(number)
        const mimeType = mime.lookup(filePath);
        const fileName = filePath.split('/').pop();
        return this.vendor.sendMessage(numberClean, {
            document: { url: filePath },
            mimetype: mimeType,
            fileName: fileName,
        })
    }

    /**
     * @deprecated
     * @param {string} number
     * @param {string} text
     * @param {string} footer
     * @param {Array} buttons
     * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
     */

    sendButtons = async (number: string, text: string, buttons: any[]): Promise<any> => {
        const numberClean = UtilsBaileys.formatPhone(number)

        const templateButtons = buttons.map((btn, i) => ({
            buttonId: `id-btn-${i}`,
            buttonText: { displayText: btn.body },
            type: 1,
        }));

        const buttonMessage = {
            text,
            footer: '',
            buttons: templateButtons,
            headerType: 1,
        };

        return this.vendor.sendMessage(numberClean, buttonMessage)
    }

    /**
    *
    * @param {string} number
    * @param {string} text
    * @param {string} footer
    * @param {Array} poll
    * @example await sendMessage("+XXXXXXXXXXX", "Your Text", "Your Footer", [{"buttonId": "id", "buttonText": {"displayText": "Button"}, "type": 1}])
    */

    sendPoll = async (number: string, text: string, poll: any): Promise<boolean> => {
        const numberClean = UtilsBaileys.formatPhone(number)

        if (poll.options.length < 2) return false

        const pollMessage = {
            name: text,
            values: poll.options,
            selectableCount: 1
        };
        return this.vendor.sendMessage(numberClean, { poll: pollMessage })
    }

    /**
     * @param {string} number
     * @param {string} message
     * @example await sendMessage('+XXXXXXXXXXX', 'Hello World')
     */


    sendMessage = async (numberIn: string, message: string, options: SendMessageOptions): Promise<any> => {
        const number = UtilsBaileys.formatPhone(numberIn);

        if (options.options.buttons?.length) {
            return this.sendPoll(number, message, {
                options: options.options.buttons.map((btn, i) => (btn.body)) ?? [],
            })
        }
        if (options.options?.media) return this.sendMedia(number, options.options.media, message)
        return this.sendText(number, message)
    }

    /**
     * @param {string} remoteJid
     * @param {string} latitude
     * @param {string} longitude
     * @param {any} messages
     * @example await sendLocation("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "xx.xxxx", "xx.xxxx", messages)
     */

    sendLocation = async (remoteJid: string, latitude: string, longitude: string, messages: any = null): Promise<{ status: string }> => {
        await this.vendor.sendMessage(
            remoteJid,
            {
                location: {
                    degreesLatitude: latitude,
                    degreesLongitude: longitude,
                },
            },
            { quoted: messages }
        );

        return { status: 'success' }
    }

    /**
     * @param {string} remoteJid
     * @param {string} contactNumber
     * @param {string} displayName
     * @param {any} messages - optional
     * @example await sendContact("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "+xxxxxxxxxxx", "Robin Smith", messages)
     */

    sendContact = async (remoteJid: string, contactNumber: string, displayName: string, messages: any = null): Promise<{ status: string }> => {

        const cleanContactNumber = contactNumber.replace(/ /g, '');
        const waid = cleanContactNumber.replace('+', '');

        const vcard =
            'BEGIN:VCARD\n' +
            'VERSION:3.0\n' +
            `FN:${displayName}\n` +
            'ORG:Ashoka Uni;\n' +
            `TEL;type=CELL;type=VOICE;waid=${waid}:${cleanContactNumber}\n` +
            'END:VCARD';

        await this.vendor.sendMessage(
            remoteJid,
            {
                contacts: {
                    displayName: displayName,
                    contacts: [{ vcard }],
                },
            },
            { quoted: messages }
        );

        return { status: 'success' }
    }

    /**
     * @param {string} remoteJid
     * @param {string} WAPresence
     * @example await sendPresenceUpdate("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "recording")
     */
    sendPresenceUpdate = async (remoteJid: string, WAPresence: string): Promise<void> => {
        await this.vendor.sendPresenceUpdate(WAPresence, remoteJid);
    }

    /**
     * @param {string} remoteJid
     * @param {string} url
     * @param {object} stickerOptions
     * @param {any} messages - optional
     * @example await sendSticker("xxxxxxxxxxx@c.us" || "xxxxxxxxxxxxxxxxxx@g.us", "https://dn/image.png" || "https://dn/image.gif" || "https://dn/image.mp4", {pack: 'User', author: 'Me'}, messages)
     */

    sendSticker = async (remoteJid: string, url: string, stickerOptions: any, messages: any = null): Promise<void> => {
        const number = UtilsBaileys.formatPhone(remoteJid);
        const fileDownloaded = await UtilsBaileys.generalDownload(url);

        await this.vendor.sendMessage(number, {
            sticker: {
                url: fileDownloaded
            },
        }, { quoted: messages });
    }

    /**
     * Logs out the current session by calling the vendor's logout method.
     * Ensures that any active connections are terminated.
     * @returns {Promise<void>}
     */

    async logout() {
        if (this.vendor) {
            await this.vendor.logout();
        }
    }

    /**
     * Stop the session and destroy the vendor and store if they are valid.
     * @returns {Promise<void>}
     */
    async stop(): Promise<void> {
        this.isStopped = true;

        try {
            if (this.sock) {
                await this.sock.logout();
                if (this.store) {
                    this.store = null;
                }
                this.vendor = null;
            }
            this.removeAllListeners();
        } catch (err) {
            console.error(`[${this.globalVendorArgs.name}] Failed to stop cleanly`, err);
        }
    }

    getMe = () => {
        if (!this.vendor) {
            throw new Error('Session is not ready');
        }
        return this.vendor.user;
    }

    /**
     * Get list of chats
     * @returns {Promise<any[]>}
     */
    getChats = async (): Promise<any[]> => {
        if (!this.sock) {
            throw new Error('WhatsApp session is not ready');
        }
        if (this.store) {
            return Array.from(this.store.chats.values()).map(chat => {
                const c = chat as {
                    id: string;
                    name: string;
                    unreadCount: number;
                    messages?: { last?: { message?: { conversation?: string } } };
                };
                return {
                    id: c.id,
                    name: c.name,
                    unreadCount: c.unreadCount,
                    isGroup: c.id.endsWith('@g.us'),
                    lastMessage: c.messages?.last?.message?.conversation ?? null,
                };
            });
        }

        console.log(this.sock.chats)
        if (this.sock.chats) {
            return Array.from(this.sock.chats.values()).map(chat => {
                const c = chat as {
                    id: string;
                    name: string;
                    unreadCount: number;
                    messages?: { last?: { message?: { conversation?: string } } };
                };
                return {
                    id: c.id,
                    name: c.name,
                    unreadCount: c.unreadCount,
                    isGroup: c.id.endsWith('@g.us'),
                    lastMessage: c.messages?.last?.message?.conversation ?? null,
                };
            });
        }

        return [];
    }

    async isRegisteredNumber(phoneNumber: string): Promise<boolean> {
        if (!this.vendor) throw new Error("WhatsApp session belum siap");

        const jid = jidNormalizedUser(phoneNumber); // normalisasi jadi 628xxx
        const fullJid = jid.includes('@s.whatsapp.net') ? jid : `${jid}@s.whatsapp.net`;

        try {
            const result = await this.vendor.query({
                tag: 'iq',
                attrs: {
                    type: 'get',
                    xmlns: 'jabber:iq:register',
                    to: 's.whatsapp.net',
                },
                content: [
                    {
                        tag: 'check',
                        attrs: { jid: fullJid },
                        content: [],
                    },
                ],
            });

            return result?.content?.[0]?.attrs?.status !== 'fail';
        } catch (error) {
            console.error('Error try check number:', error);
            return false;
        }
    }

}




import { rename, createWriteStream, promises as fsPromises } from 'fs'
import { tmpdir } from 'os'
import followRedirects from 'follow-redirects';
import path from 'path';
import crypto from 'crypto';
import { extname } from 'path';


import sharp from 'sharp';
import { readFile } from 'fs';
import qr from 'qr-image';


const { http, https } = followRedirects;

interface HttpResponse {
    response: {
        headers: {
            'content-type': string
        }
    },
    fullPath: string
}

export const UtilsBaileys = {
    formatPhone: (contact: string, full: boolean = false): string => {
        let domain = contact.includes('@g.us') ? '@g.us' : '@s.whatsapp.net';
        contact = contact.replace(domain, '');
        return !full ? `${contact}${domain}` : contact;
    },
    generateRefprovider: (prefix: string = ''): string => prefix ? `${prefix}_${crypto.randomUUID()}` : crypto.randomUUID(),
    isValidNumber: (rawNumber: string): boolean => !rawNumber.match(/\@g.us\b/gm),
    prepareMedia: (media: string): { url: string } | { buffer: Buffer } => {
        if (UtilsBaileys.isUrl(media)) {
            return { url: media };
        } else {
            try {
                return { buffer: readFileSync(media) };
            } catch (e) {
                console.error(`Failed to read file at ${media}`, e);
                throw e;
            }
        }
    },
    isUrl: (s: string): boolean => {
        try {
            new URL(s);
            return true;
        } catch {
            return false;
        }
    },
    generalDownload: async (url: string): Promise<string> => {
        const checkIsLocal = existsSync(url)

        const handleDownload = (): Promise<HttpResponse> => {
            const checkProtocol = url.includes('https:')
            const handleHttp = checkProtocol ? https : http

            const name = `tmp-${Date.now()}-dat`
            const fullPath = `${tmpdir()}/${name}`
            const file = createWriteStream(fullPath)

            if (checkIsLocal) {
                /**
                 * From Local
                 */
                return new Promise((res) => {
                    const response = {
                        headers: {
                            'content-type': mime.contentType(extname(url)) || 'application/octet-stream',
                        },
                    }
                    res({ response, fullPath: url })
                })
            } else {
                /**
                 * From URL
                 */
                return new Promise((res, rej) => {
                    handleHttp.get(url, function (response) {
                        response.pipe(file)
                        file.on('finish', async function () {
                            file.close()
                            res({ response: { headers: { 'content-type': response.headers['content-type'] || 'application/octet-stream' } }, fullPath })
                        })
                        file.on('error', function () {
                            file.close()
                            rej(null)
                        })
                    })
                })
            }
        }

        const handleFile = (pathInput: string, ext: string): Promise<string> =>
            new Promise((resolve, reject) => {
                const fullPath = `${pathInput}.${ext}`
                rename(pathInput, fullPath, (err) => {
                    if (err) reject(null)
                    resolve(fullPath)
                })
            })

        const httpResponse = await handleDownload()
        const { ext } = await UtilsBaileys.fileTypeFromFile(httpResponse.response)
        const getPath = await handleFile(httpResponse.fullPath, ext)

        return getPath
    },
    convertAudio: async (filePath: string = '', format: 'mp3' | 'opus' = 'opus'): Promise<string> => {
        const formats = {
            mp3: {
                code: 'libmp3lame',
                ext: 'mp3',
            },
            opus: {
                code: 'libopus',
                ext: 'opus',
            },
        }

        const opusFilePath = path.join(path.dirname(filePath), `${path.basename(filePath, path.extname(filePath))}.${formats[format].ext}`)
        await new Promise((resolve, reject) => {
            ffmpeg(filePath)
                .audioCodec(formats[format].code)
                .audioBitrate('64k')
                .format(formats[format].ext)
                .output(opusFilePath)
                .on('end', resolve)
                .on('error', reject)
                .run()
        })
        return opusFilePath
    },
    fileTypeFromFile: async (response: { headers: { 'content-type': string } }): Promise<{ type: string, ext: string | any }> => {
        const type = response.headers['content-type'] ?? null
        const ext = mime.extension(type)
        return {
            type,
            ext,
        }
    },
    baileyGenerateImage: async (base64: string, name = 'qr.png') => {
        const PATH_QR = `${process.cwd()}/${name}`
        let qr_svg = qr.image(base64, { type: 'png', margin: 4 })

        const writeFilePromise = () =>
            new Promise((resolve, reject) => {
                const file = qr_svg.pipe(createWriteStream(PATH_QR))
                file.on('finish', () => resolve(true))
                file.on('error', reject)
            })

        await writeFilePromise()
        await UtilsBaileys.cleanImage(PATH_QR)
    },
    cleanImage: async (FROM: string): Promise<boolean> => {
        const readBuffer = async (): Promise<Buffer> => {
            const data = await fsPromises.readFile(FROM)
            return Buffer.from(data)
        }

        const imgBuffer: Buffer = await readBuffer()

        return new Promise((resolve, reject) => {
            sharp(imgBuffer, { failOnError: false })
                .extend({
                    top: 15,
                    bottom: 15,
                    left: 15,
                    right: 15,
                    background: { r: 255, g: 255, b: 255, alpha: 1 },
                })
                .toFile(FROM, (err) => {
                    if (err) reject(err)
                    resolve(true)
                })
        })
    }

}
