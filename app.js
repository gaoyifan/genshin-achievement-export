const zlib = require("zlib")
const proxy = require("udp-proxy")
const cp = require("child_process")
const rs = require("./regionServer")
const appcenter = require("./appcenter")
const { initConfig, splitPacket, upload, decodeProto, log, setupHost, KPacket, debug, checkCDN, checkUpdate } = require("./utils")
const { exportData } = require("./export");

// TODO: i18n
// TODO: send ack to avoid resend
(async () => {
    try {
        appcenter.init()
        let conf = await initConfig()
        try {
            cp.execSync("net session", { stdio: "ignore" })
        } catch (e) {
            console.log("\x1b[91m请使用管理员身份运行此程序\x1b[0m")
            return
        }
        await checkUpdate()
        checkCDN().then(_ => debug("CDN check success."))
        let unexpectedExit = true
        const gameProcess = cp.execFile(conf.executable, { cwd: conf.path },err => {
            if (err !== null && !err.killed) {
                throw err
            }
        })
        gameProcess.on("exit", () => {
            if (unexpectedExit) process.exit(0)
        })
        rs.create(conf,() => {
            setupHost()
        },(ip, port, hServer) => {
            let login = false
            let cache = new Map()
            let lastRecvTimestamp = 0
            // noinspection JSUnusedGlobalSymbols
            const options = {
                address: ip,
                port: port,
                localaddress: "127.0.0.1",
                localport: 45678,
                middleware: {
                    message: (msg, sender, next) => {
                        const buf = Buffer.from(msg)
                        if (!(login && buf.readUInt8(8) === 0x51)) {
                            next(msg, sender)
                        }
                    },
                    proxyMsg: (msg, sender, peer, next) => {
                        try { next(msg, sender, peer) } catch (e) {}
                    }
                }
            }
            let monitor;
            const createMonitor = () => {
                monitor = setInterval(async () => {
                    if (login && lastRecvTimestamp + 2 < parseInt(Date.now() / 1000)) {
                        unexpectedExit = false
                        server.close()
                        hServer.close()
                        gameProcess.kill()
                        clearInterval(monitor)
                        setupHost(true)
                        console.log("正在处理数据，请稍后...")
                        let packets = Array.from(cache.values())
                        cache.clear()
                        packets.sort((a, b) => a.frg - b.frg)
                            .sort((a, b) => a.sn - b.sn)
                            .filter(i => i.data.byteLength !== 0)
                            .forEach(i => {
                                const psn = i.sn + i.frg
                                cache.has(psn) ? (() => {
                                    const arr = cache.get(psn)
                                    arr.push(i.data)
                                    cache.set(psn, arr)
                                })() : cache.set(psn, [i.data])
                            })
                        packets = Array.from(cache.values())
                            .map(arr => {
                                const data = Buffer.concat(arr)
                                const len = Buffer.alloc(4)
                                len.writeUInt32LE(data.length)
                                return Buffer.concat([len, data])
                            })
                        const merged = Buffer.concat(packets)
                        const compressed = zlib.brotliCompressSync(merged)
                        const response = await upload(compressed)
                        if (response.status !== 200) {
                            log(`发生错误: ${response.data.toString()}`)
                            log(`请求ID: ${response.headers["x-api-requestid"]}`)
                            log("请联系开发者以获取帮助")
                        } else {
                            const data = zlib.brotliDecompressSync(response.data)
                            const proto = await decodeProto(data,"AllAchievement")
                            await exportData(proto)
                            console.log("按任意键退出")
                            cp.execSync("pause > nul", { stdio: "inherit" })
                        }
                        process.exit(0)
                    }
                },1000)
            }
            const server = proxy.createServer(options)
            server.on("message", (msg, _) => {
                if (msg.byteLength > 500) {
                    login = true
                }
            })
            server.on("proxyMsg", (msg, _) => {
                lastRecvTimestamp = parseInt(Date.now() / 1000)
                let buf = Buffer.from(msg)
                if (buf.byteLength <= 20) {
                    switch(buf.readUInt32BE(0)) {
                        case 325:
                            createMonitor()
                            debug("服务端握手应答")
                            break
                        default:
                            console.log(`Unhandled: ${buf.toString("hex")}`)
                            process.exit(2)
                            break
                    }
                    return
                }
                splitPacket(buf).forEach(sb => {
                    if (sb.readUInt8(8) === 0x51) {
                        const p = new KPacket(sb)
                        if (!cache.has(p.hash)) cache.set(p.hash, p)
                    }
                })
            })
            return server
        }).then(() => console.log("加载完毕"))
    } catch (e) {
        if (e instanceof Error) {
            appcenter.uploadError(e, true)
        } else {
            appcenter.uploadError(Error(e), true)
        }
    }
})()