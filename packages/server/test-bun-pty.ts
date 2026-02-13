
try {
    console.log("Attempting to spawn PTY with Bun.spawn...");
    const shell = process.env.SHELL || "powershell.exe";
    const proc = Bun.spawn([shell], {
        env: process.env,
        pty: true,
        stdin: "pipe",
    });

    console.log("Spawn returned:", proc);
    console.log("Pid:", proc.pid);

    const decoder = new TextDecoder();

    // Read from PTY
    if (proc.stdout) {
        (async () => {
            const reader = proc.stdout.getReader();
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                process.stdout.write(`[PTY DATA]: ${decoder.decode(value)}`);
            }
        })();
    } else {
        console.log("No stdout?");
    }

    // Write to PTY
    setTimeout(() => {
        if (proc.stdin) {
            console.log('Writing "ls" to PTY...');
            const writer = proc.stdin.getWriter();
            writer.write(new TextEncoder().encode("ls\r"));
            writer.releaseLock();
        } else {
            console.log("No stdin available to write");
        }
    }, 2000);

    setTimeout(() => {
        console.log("Killing process...");
        proc.kill();
        process.exit(0);
    }, 5000);

} catch (e) {
    console.error("Bun.spawn { pty: true } failed:", e);
}
