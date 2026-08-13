import type { GuideModule } from "./types";

/**
 * OWNER: storage domain — the Storage browser (buckets, uploads, transforms, S3 info).
 * Ids: `storage.<surface>.<control>`.
 * Copy rules: plain English for someone new to Supabase; title ≤ 5 words;
 * body 1–2 sentences ≤ 240 chars; define the concept, then when to use it.
 */
export const storage: GuideModule = {
  // ---- /storage page shell ------------------------------------------------
  "storage.page.header": {
    title: "File storage",
    body: "Storage keeps uploaded files — images, documents, exports — in buckets, which are named containers like folders on a drive. Browse a bucket's contents here, upload files, and manage the buckets themselves.",
  },
  "storage.page.unavailable": {
    title: "Storage is not answering",
    body: "The file-storage service did not respond, or no buckets exist yet, so there is nothing to browse. No files are lost — refresh once the service is back, or create the first bucket if the create panel is shown.",
  },
  "storage.page.s3-info": {
    title: "S3 protocol details",
    body: "Storage also speaks S3, a file-transfer protocol many backup and data tools understand. These read-only facts help configure such tools; the endpoint is reachable only inside the private network and the keys never leave the server.",
  },

  // ---- browser toolbar + listing -------------------------------------------
  "storage.browser.bucket-picker": {
    title: "Choose a bucket",
    body: "A bucket is a named container of files with its own access rules. Pick one to browse its contents; buckets marked (public) let anyone with a file's link read it without signing in.",
  },
  "storage.buckets.new": {
    title: "Create a bucket",
    body: "Opens a form for a new file container. You choose its name (permanent), whether it is public, an optional per-file size cap, and which file types it accepts.",
  },
  "storage.browser.breadcrumb": {
    title: "Where you are",
    body: "The bucket and folder path you are browsing, like a trail of folder names. Click an earlier segment to jump back up; the last segment is the folder listed below.",
  },
  "storage.browser.upload": {
    title: "Upload a file",
    body: "Adds a file to the folder you are viewing. Files over 6 MB upload in resumable chunks that survive network blips; uploads never overwrite an existing file — delete the old one first.",
  },
  "storage.browser.objects": {
    title: "Files in this folder",
    body: "Each row is a file or folder at the current location, with its type, size, and last update. Folders open on click; files can be previewed, downloaded, renamed, or deleted from their row.",
  },
  "storage.browser.folder": {
    title: "Open this folder",
    body: "Folders group files inside a bucket, like directories on a disk. Click to look inside; use the path in the toolbar to come back up.",
  },
  "storage.browser.rename-editor": {
    title: "New name or path",
    body: "Type the file's new full path inside the bucket — including a slash moves it into a folder (brand/logo.png). Save applies it; anything still using the old path stops working.",
  },
  "storage.browser.preview": {
    title: "Preview this image",
    body: "Shows the image right here without downloading it, with controls to try resized or recompressed versions. Safe to click — nothing about the stored file changes.",
  },
  "storage.browser.download": {
    title: "Download this file",
    body: "Fetches the file to your computer through the console, so the private storage service is never exposed directly. Safe — the stored copy is unchanged.",
  },
  "storage.browser.rename": {
    title: "Rename or move",
    body: "Opens an inline editor for the file's path. Renaming also moves — the file itself is untouched, but anything pointing at the old path will no longer find it.",
  },
  "storage.browser.delete": {
    title: "Delete this file",
    body: "Starts removing the file from the bucket. Nothing happens until you confirm in the next step, but once confirmed the file is permanently gone — there is no trash or undo.",
  },
  "storage.browser.confirm-delete": {
    title: "Point of no return",
    body: "Confirm delete permanently destroys this file — it cannot be recovered. Keep cancels and leaves the file exactly as it is.",
  },

  // ---- resumable upload rows ------------------------------------------------
  "storage.uploads.panel": {
    title: "Uploads in progress",
    body: "Each row is a large file uploading in small resumable chunks, so a dropped connection continues where it left off instead of starting over. The panel appears only while uploads are queued or running.",
  },
  "storage.uploads.rejection": {
    title: "File was refused",
    body: "This file was rejected before any data left your computer — usually an unsafe name or a size over the 1 GB cap. Fix the file and retry; Dismiss just clears this notice.",
  },
  "storage.uploads.pause": {
    title: "Pause or resume",
    body: "Pausing stops sending data but keeps everything uploaded so far; Resume continues from that exact point. Useful on a slow or metered connection.",
  },
  "storage.uploads.retry": {
    title: "Retry this upload",
    body: "Restarts a failed upload from the last chunk that arrived, not from zero. Use it after a network drop or a server hiccup.",
  },
  "storage.uploads.remove": {
    title: "Cancel this upload",
    body: "Stops the upload and clears the row. An unfinished file is abandoned mid-way and will not appear in the bucket; a finished one stays — removing then only tidies this list.",
  },

  // ---- image transform preview ----------------------------------------------
  "storage.transform.width": {
    title: "Resize width",
    body: "Target width in pixels (1–2000) for the transformed copy. Leave empty to keep the original width — transforms are made on the fly and the stored file is never altered.",
  },
  "storage.transform.height": {
    title: "Resize height",
    body: "Target height in pixels (1–2000). Combine with width and the resize mode to control cropping; the original file stays untouched.",
  },
  "storage.transform.resize": {
    title: "Resize mode",
    body: "How the image fits the width and height: cover fills the box and crops the overflow, contain shrinks to fit with nothing cropped, fill stretches to the exact size and may distort.",
  },
  "storage.transform.quality": {
    title: "Compression quality",
    body: "How compressed the transformed image is, from 20 to 100. Lower numbers mean smaller files but more visible artifacts; empty uses the server default.",
  },
  "storage.transform.format": {
    title: "Output format",
    body: "The file format of the transformed copy. origin keeps the image's own format; avif is a modern format that is much smaller at the same quality, though very old browsers cannot display it.",
  },
  "storage.transform.copy-url": {
    title: "Copy transform link",
    body: "Copies a link that serves the image with these exact transform settings applied. It is not a public URL — whoever uses it must still be allowed into this console.",
  },
  "storage.transform.unavailable": {
    title: "Transforms are off here",
    body: "This deployment's image-transform service (imgproxy) is not running, so resized copies cannot be made right now. The untransformed preview and downloads still work.",
  },
  "storage.transform.no-transforms": {
    title: "Not a transformable image",
    body: "Transforms only work on common image types (PNG, JPEG, GIF, WebP, AVIF, SVG). This file's type is not one of them, so it can only be previewed or downloaded as-is.",
  },

  // ---- bucket management ------------------------------------------------------
  "storage.buckets.table": {
    title: "All buckets",
    body: "Each row is a bucket — a named container of files with its own rules: public means anyone with a link can read its files, the size limit caps each upload, and allowed types restrict what can be stored.",
  },
  "storage.buckets.edit": {
    title: "Edit bucket settings",
    body: "Changes this bucket's visibility, size limit, and allowed file types. The name can never change, and switching a bucket to public exposes every file in it to anyone with a link.",
  },
  "storage.buckets.empty": {
    title: "Delete every file inside",
    body: "Permanently deletes all files in this bucket; the empty bucket itself remains. You must type the bucket's name to confirm, and there is no undo.",
  },
  "storage.buckets.delete": {
    title: "Delete this bucket",
    body: "Permanently removes the bucket itself. It must already be empty (use Empty first), you must type its name to confirm, and there is no undo.",
  },
  "storage.buckets.confirm-name": {
    title: "Type the name to confirm",
    body: "A guard against destroying the wrong thing: the action only runs if you type the bucket's exact name. Anything else cancels safely.",
  },

  // ---- bucket create/edit dialog ------------------------------------------------
  "storage.bucket-form.title": {
    title: "Bucket settings",
    body: "A bucket is a named container of files with its own access rules, and this form sets those rules. On an existing bucket, saving replaces every setting with exactly what the form shows.",
  },
  "storage.bucket-form.name": {
    title: "Bucket name",
    body: "The permanent identifier for this container — it appears in every file link and can never be renamed, only deleted and recreated. Letters, digits, dots, dashes, and underscores.",
  },
  "storage.bucket-form.public": {
    title: "Public or private",
    body: "Public means anyone with a file's URL can read it — no sign-in, no expiry. Private files are reachable only through short-lived signed links; stay private unless every file is meant for the open internet.",
  },
  "storage.bucket-form.size-limit": {
    title: "Per-file size cap",
    body: "The biggest single file this bucket accepts. Uploads over the cap are refused; leave it empty for no bucket-specific cap — the server-wide limit still applies.",
  },
  "storage.bucket-form.mime-types": {
    title: "Allowed file types",
    body: "Restricts what can be stored, using MIME types — standard format labels like image/png. Comma-separated, wildcards such as image/* work, and empty accepts every type.",
  },
  "storage.bucket-form.cancel": {
    title: "Discard this form",
    body: "Closes the dialog without sending anything — nothing is created or changed on the server.",
  },
  "storage.bucket-form.save": {
    title: "Apply these settings",
    body: "Creates the bucket, or on edit replaces all of its settings with what the form shows — cleared fields really are removed. Files already in the bucket are never modified.",
  },
};
