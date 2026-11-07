
const express = require("express");
const multer = require("multer");
const fs = require("fs/promises");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();

const PORT = process.env.PORT || 10000;
const PASSWORD = process.env.BUILDER_PASSWORD;

if (!PASSWORD || PASSWORD.length < 12) {
    console.error("BUILDER_PASSWORD must contain at least 12 characters.");
    process.exit(1);
}

app.disable("x-powered-by");

function safeEqual(a, b) {
    const aa = Buffer.from(a);
    const bb = Buffer.from(b);

    return aa.length === bb.length &&
        crypto.timingSafeEqual(aa, bb);
}

// Защита всего сайта через HTTP Basic Auth.
function requireAuth(req, res, next) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Basic ")) {
        return askAuth(res);
    }

    let decoded;

    try {
        decoded = Buffer.from(
            header.slice(6),
            "base64"
        ).toString("utf8");
    } catch {
        return askAuth(res);
    }

    const separator = decoded.indexOf(":");

    if (separator < 0) {
        return askAuth(res);
    }

    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);

    if (
        username !== "owner" ||
        !safeEqual(password, PASSWORD)
    ) {
        return askAuth(res);
    }

    next();
}

function askAuth(res) {
    res.set(
        "WWW-Authenticate",
        'Basic realm="Forge JAR Builder", charset="UTF-8"'
    );

    return res.status(401).send("Authentication required");
}

// Все страницы и API защищены паролем.
app.use(requireAuth);
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 2 * 1024 * 1024,
        files: 2
    }
});

const jobs = new Map();

let activeBuild = false;

function appendLog(job, message) {
    job.log += String(message);

    if (job.log.length > 20000) {
        job.log = job.log.slice(-20000);
    }
}

function scheduleCleanup(job) {
    const timer = setTimeout(async () => {
        jobs.delete(job.id);

        if (job.dir) {
            await fs.rm(job.dir, {
                recursive: true,
                force: true
            }).catch(() => {});
        }
    }, 30 * 60 * 1000);

    timer.unref();
}

// Подстановка переменных из стандартного Forge MDK mods.toml.
function prepareToml(toml, modId) {
    const replacements = {
        "file.jarVersion": "1.0.0",
        "loader_version_range": "[47,)",
        "minecraft_version_range": "[1.20.1,1.20.2)",
        "forge_version_range": "[47,)",
        "minecraft_version": "1.20.1",
        "forge_version": "47.4.0",
        "mod_id": modId,
        "mod_name": modId,
        "mod_license": "All Rights Reserved",
        "mod_version": "1.0.0",
        "mod_authors": "Unknown",
        "mod_description": "Uploaded Forge mod"
    };

    const result = toml.replace(
        /\$\{([^}]+)\}/g,
        (whole, key) => replacements[key] ?? whole
    );

    const unknown = result.match(/\$\{[^}]+\}/);

    if (unknown) {
        throw new Error(
            "Неизвестная переменная в mods.toml: " + unknown[0]
        );
    }

    return result;
}

function createBuildGradle() {
    return `
buildscript {
    repositories {
        maven {
            url = 'https://maven.minecraftforge.net'
        }
        mavenCentral()
    }

    dependencies {
        classpath 'net.minecraftforge.gradle:ForgeGradle:6.0.+'
    }
}

apply plugin: 'net.minecraftforge.gradle'

group = 'personal'
version = '1.0.0'

base {
    archivesName = 'forge-upload'
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(17)
    }
}

minecraft {
    mappings channel: 'official', version: '1.20.1'
}

dependencies {
    minecraft 'net.minecraftforge:forge:1.20.1-47.4.0'
}

tasks.withType(JavaCompile).configureEach {
    options.encoding = 'UTF-8'
}

tasks.named('jar', Jar).configure {
    manifest {
        attributes([
            'Specification-Title': 'forge-upload',
            'Specification-Vendor': 'personal',
            'Specification-Version': '1',
            'Implementation-Title': project.name,
            'Implementation-Version': project.version
        ])
    }

    finalizedBy 'reobfJar'
}
`;
}

function runGradle(projectDir, job) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "gradle",
            [
                "--no-daemon",
                "--max-workers=1",
                "--console=plain",
                "build"
            ],
            {
                cwd: projectDir,
                env: {
                    ...process.env,
                    GRADLE_OPTS: "-Dorg.gradle.daemon=false"
                }
            }
        );

        const timeout = setTimeout(() => {
            appendLog(job, "\n[BUILDER] Превышено время сборки.\n");
            child.kill("SIGTERM");

            setTimeout(() => {
                child.kill("SIGKILL");
            }, 5000).unref();
        }, 12 * 60 * 1000);

        child.stdout.on("data", data => {
            appendLog(job, data);
        });

        child.stderr.on("data", data => {
            appendLog(job, data);
        });

        child.on("error", error => {
            clearTimeout(timeout);
            reject(error);
        });

        child.on("close", code => {
            clearTimeout(timeout);
            resolve(code);
        });
    });
}

async function runBuild(job, javaFile, tomlText, modId) {
    let projectDir;

    try {
        job.dir = await fs.mkdtemp(
            path.join(os.tmpdir(), "forge-builder-")
        );

        projectDir = path.join(job.dir, "project");

        const javaDir = path.join(
            projectDir,
            "src",
            "main",
            "java"
        );

        const resourcesDir = path.join(
            projectDir,
            "src",
            "main",
            "resources",
            "META-INF"
        );

        await fs.mkdir(javaDir, { recursive: true });
        await fs.mkdir(resourcesDir, { recursive: true });

        // Java-файл.
        await fs.writeFile(
            path.join(javaDir, javaFile.name),
            javaFile.buffer
        );

        // mods.toml.
        await fs.writeFile(
            path.join(resourcesDir, "mods.toml"),
            tomlText
        );

        // Генерируем файлы Gradle автоматически.
        await fs.writeFile(
            path.join(projectDir, "build.gradle"),
            createBuildGradle()
        );

        await fs.writeFile(
            path.join(projectDir, "settings.gradle"),
            "rootProject.name = 'ForgeUpload'\n"
        );

        await fs.writeFile(
            path.join(projectDir, "gradle.properties"),
            [
                "org.gradle.jvmargs=-Xmx256m -XX:MaxMetaspaceSize=128m -XX:ReservedCodeCacheSize=32m -Dfile.encoding=UTF-8",
                "org.gradle.daemon=false",
                "org.gradle.parallel=false",
                "org.gradle.workers.max=1",
                "org.gradle.caching=true",
                "org.gradle.configuration-cache=false"
            ].join("\n")
        );

        appendLog(job, "Проект подготовлен.\n");
        appendLog(job, "Minecraft: 1.20.1\n");
        appendLog(job, "Forge: 47.4.0\n");
        appendLog(job, "Mod ID: " + modId + "\n");
        appendLog(job, "Запуск Gradle...\n\n");

        const code = await runGradle(projectDir, job);

        if (code !== 0) {
            throw new Error(
                "Gradle завершил работу с кодом " + code
            );
        }

        const libsDir = path.join(projectDir, "build", "libs");

        const files = await fs.readdir(libsDir);

        const jarFile = files.find(name =>
            name.endsWith(".jar") &&
            !name.endsWith("-sources.jar") &&
            !name.endsWith("-javadoc.jar") &&
            !name.includes("-dev")
        );

        if (!jarFile) {
            throw new Error("Готовый JAR не найден.");
        }

        job.jarPath = path.join(job.dir, "result.jar");

        await fs.copyFile(
            path.join(libsDir, jarFile),
            job.jarPath
        );

        job.status = "success";

        appendLog(job, "\nBUILD SUCCESSFUL\n");
        appendLog(job, "JAR успешно создан.\n");

    } catch (error) {
        job.status = "error";
        job.error = error.message;

        appendLog(
            job,
            "\nBUILD FAILED\n" + error.message + "\n"
        );

    } finally {
        if (projectDir) {
            await fs.rm(projectDir, {
                recursive: true,
                force: true
            }).catch(() => {});
        }

        activeBuild = false;
        scheduleCleanup(job);
    }
}

// Создание новой сборки.
app.post(
    "/api/build",
    upload.fields([
        { name: "javaFile", maxCount: 1 },
        { name: "tomlFile", maxCount: 1 }
    ]),
    async (req, res) => {

        if (activeBuild) {
            return res.status(429).json({
                error: "Другая сборка уже выполняется."
            });
        }

        const javaFile = req.files?.javaFile?.[0];
        const tomlFile = req.files?.tomlFile?.[0];

        if (!javaFile || !tomlFile) {
            return res.status(400).json({
                error: "Нужно загрузить оба файла."
            });
        }

        const javaName = path.basename(
            javaFile.originalname.replace(/\\/g, "/")
        );

        if (!/^[A-Za-z_$][A-Za-z0-9_$]*\.java$/.test(javaName)) {
            return res.status(400).json({
                error: "Некорректное имя Java-файла."
            });
        }

        if (!tomlFile.originalname.toLowerCase().endsWith(".toml")) {
            return res.status(400).json({
                error: "Второй файл должен быть .toml."
            });
        }

        const javaText = javaFile.buffer.toString("utf8");
        let tomlText = tomlFile.buffer.toString("utf8");

        const tomlId = tomlText.match(
            /^\s*modId\s*=\s*["']([a-z][a-z0-9_]*)["']/m
        );

        const javaId =
            javaText.match(/@Mod\s*\(\s*"([a-z][a-z0-9_]*)"\s*\)/) ||
            javaText.match(/MOD_ID\s*=\s*"([a-z][a-z0-9_]*)"/);

        const modId = tomlId?.[1] || javaId?.[1];

        if (!modId) {
            return res.status(400).json({
                error: "Не удалось определить modId. Укажи его в mods.toml или Java-файле."
            });
        }

        try {
            tomlText = prepareToml(tomlText, modId);
        } catch (error) {
            return res.status(400).json({
                error: error.message
            });
        }

        activeBuild = true;

        const id = crypto.randomUUID();

        const job = {
            id,
            status: "building",
            log: "",
            error: null,
            dir: null,
            jarPath: null
        };

        jobs.set(id, job);

        // Запускаем сборку в фоне.
        runBuild(
            job,
            {
                name: javaName,
                buffer: javaFile.buffer
            },
            tomlText,
            modId
        );

        res.status(202).json({ id });
    }
);

// Получение статуса сборки.
app.get("/api/build/:id", (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job) {
        return res.status(404).json({
            error: "Сборка не найдена или уже удалена."
        });
    }

    res.set("Cache-Control", "no-store");

    res.json({
        status: job.status,
        log: job.log,
        error: job.error,
        downloadReady: job.status === "success"
    });
});

// Скачивание готового JAR.
app.get("/api/download/:id", async (req, res) => {
    const job = jobs.get(req.params.id);

    if (!job || job.status !== "success" || !job.jarPath) {
        return res.status(404).json({
            error: "Готовый JAR пока недоступен."
        });
    }

    res.download(job.jarPath, "forge-mod-1.20.1.jar");
});

// Ошибки загрузки файлов.
app.use((error, req, res, next) => {
    if (error instanceof multer.MulterError) {
        return res.status(400).json({
            error: "Ошибка загрузки: " + error.message
        });
    }

    console.error(error);

    res.status(500).json({
        error: "Внутренняя ошибка сервера."
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log("Forge JAR Builder started on port " + PORT);
});
