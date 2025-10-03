# WhatsApp Baileys Library

This library is designed to simplify WhatsApp integration with **multi-session support**, **structured logging**, and **comprehensive media handling**. Built with **TypeScript** to ensure better type safety and a more reliable development experience.

---

## ✨ Key Features

* **Multi-Session Support**: Manage and maintain multiple WhatsApp connections simultaneously.
* **Comprehensive Media Handling**: Supports sending, receiving, and managing various types of media (images, videos, files).
* **Structured Logging**: Uses [Pino](https://github.com/pinojs/pino) for clean and easy-to-debug logs.
* **QR Code in Terminal**: Leverages `qrcode-terminal` for quick login in the terminal when creating a new session.
* **Built with TypeScript**: Ensures type safety and a more reliable developer experience.

---

## 🚀 Installation

Make sure you have **Node.js** and **npm** installed.

### Clone Repository And Test Local

```bash
git clone https://github.com/denifrahman/wasocket-baileys
cd wasocket-baileys
```

### Install Dependencies

```bash
npm install
```

---


## Usage Your Project
```bash
npm i wasocket-baileys
```

## ⚙️ Usage & Scripts

### 1. Run Example (Development)

Use this script to run the example file `example/index.ts` with **ts-node**.
This is the fastest way to try out the library:

```bash
npm run start:example
```

---

## 📂 Project Structure

```
wasocket-baileys/
├── src/               # Main TypeScript source code
│   └── baileys.ts
│   └── utils.ts       # Library entry point
├── dist/              # Compiled output (JavaScript & type definitions)
├── example/           # Example implementation of the library
│   └── index.ts
├── package.json       # Project metadata & configuration
├── tsconfig.json      # TypeScript configuration
├── .gitignore
└── README.md          # Project documentation
```

---


## 📜 Example Usage 
```typescript
// example/index.ts

import * as dotenv from 'dotenv';
import utils from '../src/utils';
import { BaileysClass } from '../src/baileys';
import * as qrcode from 'qrcode-terminal';
import inquirer from 'inquirer';
import { join } from 'path';
import { readdirSync, statSync } from 'fs';
import { downloadMediaMessage } from '@whiskeysockets/baileys';

// Muat environment variables
dotenv.config({ path: '.env' });

const activeSessions: Map<string, BaileysClass> = new Map();

const SESSION_NAME = 'my-first-bot';
const PHONE_NUMBER = process.env.PHONE_NUMBER;
const USE_PAIRING_CODE = process.env.USE_PAIRING_CODE === 'true';


const handleNewSession = async (): Promise<void> => {
    const { name } = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Masukkan nama sesi baru (e.g., bot_retail):',
            default: SESSION_NAME,
        },
    ]);

    if (activeSessions.has(name)) {
        console.log(`\n❌ Sesi '${name}' sudah aktif atau sudah ada. Gunakan [2] Start Session.`);
        return mainPrompt();
    }

    // Inisialisasi BaileysClass
    const newBot = new BaileysClass({
        name: name,
        debug: true
        // Anda bisa tambahkan: usePairingCode: true, phoneNumber: '628xxxx' di sini
    });

    // Setup listeners sebelum BaileysClass sempat konek
    setupSessionEvents(name, newBot);

    // Simpan instance ke peta
    activeSessions.set(name, newBot);

    console.log(`\n✨ Sesi '${name}' sedang diinisialisasi. Tunggu hingga QR muncul...`);
    // BaileysClass.initBailey() akan dipanggil di constructor, jadi kita tunggu event QR/ready

    newBot.on('ready', () => {
        console.log(`\n🟢 [READY] Sesi '${name}' terhubung!`);
        // Anda bisa memanggil mainPrompt() di sini jika ingin kembali ke menu
    });

    mainPrompt();
};

const handleStartSession = async (): Promise<void> => {
    const { name } = await inquirer.prompt([
        {
            type: 'input',
            name: 'name',
            message: 'Masukkan nama sesi yang ingin dimulai:',
            default: SESSION_NAME,
        },
    ]);

    let botInstance = activeSessions.get(name);

    if (!botInstance) {
        // Jika sesi belum ada di memory, buat instance baru
        botInstance = new BaileysClass({ name: name, debug: true });
        setupSessionEvents(name, botInstance);
        activeSessions.set(name, botInstance);
        console.log(`\n🔄 Sesi '${name}' diinisialisasi ulang dari disk.`);
    } else {
        console.log(`\n⚠️ Sesi '${name}' sudah aktif. Tidak perlu dimulai ulang.`);
    }

    mainPrompt();
};

const handleStopSession = async (): Promise<void> => {
    const sessionNames = Array.from(activeSessions.keys());

    if (sessionNames.length === 0) {
        console.log('\n⚠️ Tidak ada sesi aktif untuk dihentikan.');
        return mainPrompt();
    }

    const { name } = await inquirer.prompt([
        {
            type: 'list',
            name: 'name',
            message: 'Pilih sesi yang ingin dihentikan:',
            choices: sessionNames,
        },
    ]);

    const botInstance = activeSessions.get(name);

    if (botInstance) {
        await botInstance.stop(); // Memanggil metode stop() yang Anda buat
        activeSessions.delete(name);
        console.log(`\n🛑 Sesi '${name}' telah berhasil dihentikan dan di-logout.`);
    }

    mainPrompt();
};

const handleGetSessions = (): void => {
    console.log('\n=======================================');
    console.log('       STATUS SEMUA SESI AKTIF');
    console.log('=======================================');

    if (activeSessions.size === 0) {
        console.log('  Tidak ada sesi yang sedang berjalan. 😭');
    } else {
        activeSessions.forEach((bot, name) => {
            const status = bot.getInstance() ? '🟢 READY' : '🟡 WAITING';
            const user = bot.getInstance()?.user?.id || 'N/A';
            console.log(`  [${name.toUpperCase()}] Status: ${status} | JID: ${user}`);
        });
    }

    console.log('=======================================\n');
    mainPrompt();
};

const mainPrompt = async () => {
    const { action } = await inquirer.prompt([
        {
            type: 'list',
            name: 'action',
            message: 'Pilih aksi yang ingin dilakukan:',
            choices: [
                '[1] New Session (Buat & Mulai)',
                '[2] Start Session (Hanya Re-connect/Re-init)',
                '[3] Stop Session (Logout)',
                '[4] Get All Sessions (Lihat Status)',
                '[5] Restore All Sessions (Mulai ulang semua sesi dari disk) 💾',
                '[6] Keluar',
            ],
        },
    ]);

    const choice = action.split(']')[0].replace('[', '');

    switch (choice) {
        case '1':
            await handleNewSession();
            break;
        case '2':
            await handleStartSession();
            break;
        case '3':
            await handleStopSession();
            break;
        case '4':
            handleGetSessions();
            break;
        case '5':
            await handleRestoreAllSessions();
            break;
        case '6':
            console.log('👋 Sampai jumpa!');
            process.exit(0);
        default:
            mainPrompt();
    }
};

const handleRestoreAllSessions = async (): Promise<void> => {
    console.log('\n🔍 Memulihkan sesi yang tersimpan di disk...');

    const baseDir = process.cwd();

    const sessionFolderList: string[] = readdirSync(baseDir)
        .filter(name =>
            name.endsWith('_sessions') &&
            statSync(join(baseDir, name)).isDirectory()
        );

    if (sessionFolderList.length === 0) {
        console.log('⚠️ Tidak ada folder sesi yang ditemukan untuk dipulihkan.');
        return mainPrompt();
    }

    const sessionsToStart: string[] = [];

    // 2. Iterasi melalui daftar folder yang ditemukan
    for (const folderName of sessionFolderList) {
        // Ekstrak nama sesi (e.g., 'bot_sessions' menjadi 'bot')
        const sessionName = folderName.replace(/_sessions$/, '');

        // Cek apakah sesi ini sudah aktif di memori
        if (activeSessions.has(sessionName)) {
            console.log(`🟡 Sesi '${sessionName}' sudah berjalan. Melewatkan.`);
            continue;
        }

        // Tambahkan ke list sesi yang akan dimulai
        sessionsToStart.push(sessionName);
    }

    if (sessionsToStart.length === 0) {
        console.log('Semua sesi yang ditemukan sudah aktif atau tidak ada yang baru untuk dipulihkan.');
        return mainPrompt();
    }

    console.log(`\n🚀 Memulai ulang ${sessionsToStart.length} sesi: ${sessionsToStart.join(', ')}`);

    // 3. Iterasi melalui list nama sesi yang perlu dimulai ulang
    for (const sessionName of sessionsToStart) {
        console.log(`[START] Memulai sesi: ${sessionName}...`);

        // Buat instance BaileysClass baru
        const newBot = new BaileysClass({
            name: sessionName,
            debug: false // Atur ke false saat restore
        });

        // Set up event listeners
        setupSessionEvents(sessionName, newBot);

        // Simpan ke daftar aktif
        activeSessions.set(sessionName, newBot);

        // Tambahkan jeda antar sesi
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('\n✅ Proses pemulihan sesi selesai. Periksa status dengan [4].');
    mainPrompt();
};

const setupSessionEvents = (sessionName: string, botInstance: BaileysClass): void => {

    // LOGIKA QR CODE
    botInstance.on('qr', (qrCode: string) => {
        console.log(`\n--- 🤖 ${sessionName.toUpperCase()} WAITING FOR SCAN ---`);

        // Tampilkan QR Code di Terminal
        qrcode.generate(qrCode, { small: true }, (qr) => {
            console.log(qr);
        });

        // Simpan sebagai file
        const filename = `${sessionName}.qr.png`;
        utils.baileyGenerateImage(qrCode, filename).then(() => {
            console.log(`[FILE] QR Code disimpan sebagai ${filename}`);
        }).catch(err => console.error("Gagal menyimpan QR:", err));

        console.log('---------------------------------------------------\n');
    });

    // LOGIKA READY
    botInstance.on('ready', () => {
        console.log(`\n🟢 [READY] Sesi '${sessionName}' terhubung!`);
        // Anda bisa memanggil mainPrompt() di sini jika ingin kembali ke menu
    });

    // LOGIKA DISCONNECT
    botInstance.on('disconnected', (info: { code: number, reason: string }) => {
        console.log(`\n🔴 [DISCONNECT] Sesi '${sessionName}' terputus. Kode: ${info.code}, Alasan: ${info.reason}`);
        activeSessions.delete(sessionName);
        // Anda bisa memanggil mainPrompt() di sini
    });

    botInstance.on('messages.upsert', async (messages) => {
        console.log(`\n🔔 [MESSAGE] Pesan baru diterima: ${JSON.stringify(messages)}`);

        for (const msg of messages) {
            if (msg.message?.imageMessage) {
                const buffer = await downloadMediaMessage(
                    msg,
                    'buffer',
                    {}
                );
                const filename = `img-${msg.key.id}.jpg`;
                console.log(`[FILE] Gambar disimpan sebagai ${filename}`);
                // Simpan file ke disk jika perlu
                require('fs').writeFile(filename, buffer, (err: any) => {
                    if (err) {
                        console.error(`Gagal menyimpan gambar: ${err}`);
                    }
                });
            }
        }
    });

    botInstance.on('chats.update', async (updates) => {
        console.log(`\n🔔 [CHAT] Pembaruan chat diterima: ${JSON.stringify(updates)}`);
    });
};

// Mulai Aplikasi
console.log('--- WhatsApp Session Manager ---');
mainPrompt();
```

## 📜 Lisensi

Proyek ini dilisensikan di bawah **ISC License**.

**Author:** [denifrahman](https://github.com/denifrahman)
