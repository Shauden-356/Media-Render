"""
Stream Video Downloader (desktop)

Saves an HLS (.m3u8) stream as a single MP4/MKV file using FFmpeg, without
re-encoding. Unlike the website, there is no time limit, so use this for long
videos.

Requirements: Python 3 (Tkinter is included) and FFmpeg on your PATH.
Not supported: encrypted / DRM-protected streams. Only download videos you
have the right to save.
"""
import os
import shutil
import subprocess
import threading
import tkinter as tk
from collections import deque
from tkinter import ttk, filedialog, messagebox


class HLSDownloader:
    def __init__(self, root):
        self.root = root
        self.root.title("Stream Video Downloader")
        self.root.geometry("620x360")
        self.process = None
        self.cancelled = False

        ttk.Label(
            root, text="HLS / Stream Video Downloader",
            font=("Arial", 16, "bold")
        ).pack(pady=(18, 10))

        ttk.Label(root, text="Video playlist URL (.m3u8):").pack(
            anchor="w", padx=20
        )
        self.url = tk.StringVar()
        ttk.Entry(root, textvariable=self.url).pack(
            fill="x", padx=20, pady=6
        )

        ttk.Label(
            root, text="Page the video is on (optional, needed by some sites):"
        ).pack(anchor="w", padx=20)
        self.referer = tk.StringVar()
        ttk.Entry(root, textvariable=self.referer).pack(
            fill="x", padx=20, pady=6
        )

        row = ttk.Frame(root)
        row.pack(fill="x", padx=20, pady=8)

        self.output = tk.StringVar(value="download.mp4")
        ttk.Entry(row, textvariable=self.output).pack(
            side="left", fill="x", expand=True
        )
        ttk.Button(
            row, text="Choose file", command=self.choose_file
        ).pack(side="left", padx=(8, 0))

        self.progress = ttk.Progressbar(
            root, mode="indeterminate", length=400
        )
        self.progress.pack(fill="x", padx=20, pady=10)

        self.status = tk.StringVar(value="Ready")
        ttk.Label(root, textvariable=self.status).pack()

        buttons = ttk.Frame(root)
        buttons.pack(pady=12)

        self.download_button = ttk.Button(
            buttons, text="Download", command=self.start_download
        )
        self.download_button.pack(side="left", padx=5)

        self.stop_button = ttk.Button(
            buttons, text="Cancel", command=self.cancel,
            state="disabled"
        )
        self.stop_button.pack(side="left", padx=5)

    def choose_file(self):
        path = filedialog.asksaveasfilename(
            title="Save video",
            defaultextension=".mp4",
            filetypes=[
                ("MP4 video", "*.mp4"),
                ("Matroska video", "*.mkv"),
                ("All files", "*.*")
            ]
        )
        if path:
            self.output.set(path)

    def start_download(self):
        url = self.url.get().strip()
        output = self.output.get().strip()
        referer = self.referer.get().strip()

        if not url.startswith(("https://", "http://")):
            messagebox.showerror(
                "Invalid URL", "Enter a valid HTTP or HTTPS URL."
            )
            return

        if not output:
            messagebox.showerror(
                "Missing filename", "Choose an output filename."
            )
            return

        if not shutil.which("ffmpeg"):
            messagebox.showerror(
                "FFmpeg not found",
                "Install FFmpeg and add it to your system PATH."
            )
            return

        if os.path.exists(output):
            if not messagebox.askyesno(
                "Overwrite file?", f"{output} already exists. Replace it?"
            ):
                return

        self.cancelled = False
        self.download_button.config(state="disabled")
        self.stop_button.config(state="normal")
        self.progress.start(10)
        self.status.set("Connecting to stream...")

        threading.Thread(
            target=self.download,
            args=(url, output, referer),
            daemon=True
        ).start()

    def build_command(self, url, output, referer):
        command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-nostdin"]

        # Web protocols only: a playlist can't make FFmpeg read local files.
        command += ["-protocol_whitelist", "http,https,tcp,tls,crypto"]
        # Retry dropped connections instead of failing the whole download.
        command += [
            "-reconnect", "1", "-reconnect_streamed", "1",
            "-reconnect_delay_max", "5",
        ]
        if referer:
            command += ["-headers", f"Referer: {referer}\r\n"]

        command += [
            "-i", url,
            # No explicit -map: FFmpeg picks the best video and audio. The old
            # "-map 0:v? -map 0:a?" copied EVERY quality level of a master
            # playlist into one file.
            "-sn", "-dn",            # subtitles/data tracks can break MP4 output
            "-c", "copy",
            "-movflags", "+faststart",
            "-progress", "pipe:1",
            "-nostats",
            output,
        ]
        return command

    def download(self, url, output, referer):
        proc = None
        errors = deque(maxlen=4)
        try:
            proc = subprocess.Popen(
                self.build_command(url, output, referer),
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1
            )
            self.process = proc

            # Read FFmpeg's error output on a thread so neither pipe can fill up.
            def drain_stderr():
                for line in proc.stderr:
                    line = line.strip()
                    if line:
                        errors.append(line)

            err_thread = threading.Thread(target=drain_stderr, daemon=True)
            err_thread.start()

            for line in proc.stdout:
                if line.startswith("out_time="):
                    elapsed = line.strip().split("=", 1)[1]
                    self.root.after(
                        0,
                        lambda t=elapsed: self.status.set(
                            f"Processing video... {t}"
                        )
                    )

            code = proc.wait()
            err_thread.join(timeout=2)

            # A flag works on every OS; negative exit codes only exist on
            # macOS/Linux, so "code < 0" missed cancellation on Windows.
            if self.cancelled:
                self.root.after(
                    0, lambda: self.finish(False, "Download cancelled.")
                )
            elif code == 0:
                self.root.after(
                    0, lambda: self.finish(
                        True, f"Video saved to:\n{output}"
                    )
                )
            else:
                detail = "\n".join(errors) or "No details were reported."
                self.root.after(
                    0, lambda d=detail: self.finish(
                        False,
                        "FFmpeg failed. Check the URL, the page address, "
                        "network access, and whether the stream is "
                        f"encrypted.\n\n{d}"
                    )
                )

        except Exception as exc:
            self.root.after(
                0, lambda err=str(exc): self.finish(False, err)
            )
        finally:
            if self.process is proc:
                self.process = None

    def cancel(self):
        proc = self.process
        if proc and proc.poll() is None:
            self.cancelled = True
            proc.terminate()
            self.status.set("Cancelling...")

    def finish(self, success, message):
        self.progress.stop()
        self.download_button.config(state="normal")
        self.stop_button.config(state="disabled")
        self.status.set("Completed" if success else "Stopped or failed")

        if success:
            messagebox.showinfo("Download complete", message)
        elif self.cancelled:
            messagebox.showinfo("Cancelled", message)
        else:
            messagebox.showerror("Download issue", message)


if __name__ == "__main__":
    root = tk.Tk()
    app = HLSDownloader(root)
    root.mainloop()
