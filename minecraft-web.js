/**
 * Downloads a file from a url and writes it to the CheerpJ filesystem.
 * @param {string} url
 * @param {string} destPath
 * @param {(downloadedBytes: number, totalBytes: number) => void} [progressCallback]
 * @returns {Promise<void>}
 */
async function downloadFileToCheerpJ(url, destPath, progressCallback) {
	const response = await fetch(url);
	const reader = response.body.getReader();
	const contentLength = +response.headers.get('Content-Length');

	const bytes = new Uint8Array(contentLength);
  progressCallback?.(0, contentLength);

	let pos = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done)
			break;
		bytes.set(value, pos);
		pos += value.length;
    progressCallback?.(pos, contentLength);
	}

	// Write to CheerpJ filesystem
	return new Promise((resolve, reject) => {
		var fds = [];
		cheerpOSOpen(fds, destPath, "w", fd => {
			cheerpOSWrite(fds, fd, bytes, 0, bytes.length, w => {
				cheerpOSClose(fds, fd, resolve);
			});
		});
	});
}

export default class MinecraftClient {
  #canvas;
  #progress;
  #button;
  #display;
  #intro;
  #isRunning;
  #jarSource;
  #logFeedback;
  #progressBar;

  /**
   * @param {Blob|string} jarSource - Blob (modded jar) or URL (original jar)
   * @param {function|undefined} logFeedback - Logging function (optional)
   * @param {HTMLElement} progressBar - Progress bar element
   */
  constructor(jarSource, logFeedback, progressBar) {
    this.#button = document.querySelector('button');
    this.#button.addEventListener('click', () => this.run());
    this.#progress = progressBar || document.querySelector('progress');
    if (this.#progress) this.#progress.style.display = 'none';
    this.#intro = document.querySelector('.intro');
    this.#display = document.querySelector('.display');
    cheerpjCreateDisplay(-1, -1, this.#display);
    this.#isRunning = false;
    this.#jarSource = jarSource;
    // Fix: always assign a function to #logFeedback
    this.#logFeedback = (typeof logFeedback === 'function') ? logFeedback : function(){};
    this.#progressBar = this.#progress;
  }

  /** @returns {Promise<number>} Exit code */
  async run() {
    if (this.#isRunning) {
      throw new Error('Already running');
    }
    this.#isRunning = true;
    if(self.plausible)
      self.plausible("Play");
    this.#intro.style.display = 'none';
    if (this.#progress) this.#progress.style.display = 'unset';
    const jarPath = "/files/client.jar";
    // Write the jar to CheerpJ VFS
    if (this.#jarSource instanceof Blob) {
      this.#logFeedback('Writing modded jar to CheerpJ VFS...');
      const buf = await this.#jarSource.arrayBuffer();
      await new Promise((resolve, reject) => {
        var fds = [];
        cheerpOSOpen(fds, jarPath, "w", fd => {
          cheerpOSWrite(fds, fd, new Uint8Array(buf), 0, buf.byteLength, w => {
            cheerpOSClose(fds, fd, resolve);
          });
        });
      });
      if (this.#progressBar) this.#progressBar.value = 2;
    } else if (typeof this.#jarSource === 'string') {
      this.#logFeedback('Downloading original jar to CheerpJ VFS...');
      await downloadFileToCheerpJ(
        this.#jarSource,
        jarPath,
        (downloadedBytes, totalBytes) => {
          if (this.#progressBar) {
            this.#progressBar.value = 1 + (downloadedBytes / (totalBytes || 1));
            this.#progressBar.max = 4;
          }
        }
      );
    } else {
      this.#logFeedback('No jar source provided!');
      throw new Error('No jar source provided');
    }

    // --- Clean mods folder for Forge (type: jar or jar-zip) after CheerpJ is initialized, before writing mods ---
    if ((window.versionType === 'jar' || window.versionType === 'jar-zip')) {
      try { await cheerpjFSDeleteTree('/files/.minecraft/mods'); } catch(e){}
    }
    // --- End cleaning mods folder ---

    // --- Handle mods folder for Forge (type: jar) using CheerpJ JS bridge ---
    if ((window.versionType === 'jar' || window.versionType === 'jar-zip')) {
      try { cheerpjCreateDirectory('/files/.minecraft'); } catch(e){}
      try { cheerpjCreateDirectory('/files/.minecraft/mods'); } catch(e){}
      if (typeof window.uploadedMods !== 'undefined' && Array.isArray(window.uploadedMods) && window.uploadedMods.length > 0) {
        // Write each mod jar to /files/.minecraft/mods
        for (const modFile of window.uploadedMods) {
          if (!modFile.name.endsWith('.jar')) continue;
          const buf = await modFile.arrayBuffer();
          await new Promise((resolve, reject) => {
            var fds = [];
            cheerpOSOpen(fds, `/files/.minecraft/mods/${modFile.name}`, "w", fd => {
              cheerpOSWrite(fds, fd, new Uint8Array(buf), 0, buf.byteLength, w => {
                cheerpOSClose(fds, fd, resolve);
              });
            });
          });
        }
      }
    }
    // --- End mods folder handling ---

    if (this.#progress) this.#progress.style.display = 'none';
    if (this.#display) this.#display.style.display = 'unset';
    // Determine main class to launch
    let mainClass = "net.minecraft.client.Minecraft";
    if (window.selectedVersionClass && typeof window.selectedVersionClass === 'string') {
      mainClass = window.selectedVersionClass;
    }
    // --- Download and install extra libraries into CheerpJ VFS ---
    if (Array.isArray(window.selectedVersionLibraries)) {
      for (const lib of window.selectedVersionLibraries) {
        if (!lib.url || !lib.path) continue;
        // Ensure the target directory exists
        const dir = lib.path.substring(0, lib.path.lastIndexOf('/'));
        try { cheerpjCreateDirectory(dir); } catch (e) {}
        // Download the library JAR into the specified path
        await downloadFileToCheerpJ(lib.url, lib.path, (done, total) => {
          console.log(`Downloading ${lib.url}: ${done}/${total}`);
        });
      }
    }
    // Build classpath: always include lwjgl jars, client jar, and any extra libraries from window.selectedVersionLibraries
    let classpath = `${jarPath}`;
    if (Array.isArray(window.selectedVersionLibraries)) {
      for (const lib of window.selectedVersionLibraries) {
        if (lib.path) {
          classpath = `${lib.path}:${classpath}`;
        }
      }
    }
    // Always append lwjgl jars at the end (not the beginning)
    classpath = `${classpath}:/app/lwjgl-2.9.3.jar:/app/lwjgl_util-2.9.3.jar`;
    this.#logFeedback(`Launching Minecraft from /files/client.jar ...`);
    // Prepare JVM (main) arguments array
    const args = Array.isArray(window.selectedVersionJvmArgs)
                 ? window.selectedVersionJvmArgs
                 : [];
    // Run the main class with arguments
    const exitCode = await cheerpjRunMain(
      mainClass,
      classpath,
      ...args
    );
    this.#isRunning = false;
    return exitCode;
  }

  /** @returns {boolean} */
  get isRunning() {
    return this.#isRunning;
  }
}

async function prepareLibrariesAndLaunch(mainJarPath, lwjglJars) {
  // Download and write libraries to VFS
  const libs = window.selectedVersionLibraries || [];
  for (const lib of libs) {
    if (!lib.url || !lib.path) continue;
    const dir = lib.path.substring(0, lib.path.lastIndexOf('/'));
    await cheerpjCreateDirectory(dir, true);
    const resp = await fetch(lib.url);
    const buf = await resp.arrayBuffer();
    await cheerpOSOpen(lib.path, 'w').then(fh => fh.write(new Uint8Array(buf)).then(() => fh.close()));
  }
  // Build classpath: libraries, main jar, LWJGL jars
  const libPaths = libs.map(l => l.path);
  const classpath = [...libPaths, mainJarPath, ...lwjglJars].join(':');
  // JVM args
  const jvmArgs = window.selectedVersionJvmArgs || [];
  // Main class
  const mainClass = window.selectedVersionClass || 'net.minecraft.client.Minecraft';
  // Launch
  cheerpjRunMain({
    classpath,
    mainClass,
    args: [],
    jvmArgs
  });
}