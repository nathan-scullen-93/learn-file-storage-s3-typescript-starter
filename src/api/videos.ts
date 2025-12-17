import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { s3, write, type BunRequest, type S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { randomBytes, sign, type UUID } from "crypto";
import { getVideo, updateVideo, type Video } from "../db/videos";
import path from "path";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: UUID };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("Uploading video file for video", videoId, "by user", userID);

  const videoFile = (await req.formData()).get("video");
  if (!videoFile || !(videoFile instanceof File)) {
    throw new BadRequestError("video is required");
  }

  let video = getVideo(cfg.db, videoId);
  if (!video) {
    console.log("Video upload failed: video not found");
    throw new NotFoundError("Couldn't find video");
  }

  if (video.userID !== userID) {
    console.log("Video upload failed: user forbidden");
    throw new UserForbiddenError(
      "You do not have permission to access this video"
    );
  }

  if (videoFile.type !== "video/mp4") {
    console.log("Video upload failed: invalid file type");
    throw new BadRequestError("Video must be a mp4 file");
  }

  const MAX_UPLOAD_SIZE = 1 * 1024 * 1024 * 1024; // 1 GB

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    console.log("Video upload failed: file size exceeds limit");
    throw new BadRequestError("Video file size exceeds the maximum limit");
  }

  //Save the uploaded video file to temp local storage
  const data = await videoFile.arrayBuffer();
  let randBytes = randomBytes(32).toString("base64url"); // Use this to generate a random filename therefore avoiding the need for caching
  const fileExtension = "mp4";
  const localPath = path.join(cfg.assetsRoot, `${randBytes}.${fileExtension}`);

  await Bun.write(localPath, data);

  //Get the aspect ratio of the video
  // then modify the filepath depending on if its landscape or portrait
  const aspectRatio = await getVideoAspectRatio(localPath);
  console.log("Video aspect ratio:", aspectRatio);

  //Upload the processed video to s3
  const processedVideo = await processVideoForFastStart(localPath);
  const processedBasename = path.basename(processedVideo); // e.g. ndy...processed.mp4
  const s3Key = `${aspectRatio}/${processedBasename}`;
  const metadata = s3.file(s3Key);

  try {
    //Copy the file to s3 storage
    await metadata.write(Bun.file(processedVideo), { type: "video/mp4" });

    //Remove the temp video file after processing
    await Bun.file(localPath).delete();
    await Bun.file(processedVideo).delete();
    console.log("Removed temporary files");

    //Update the videoURL in the database
    // const s3Url = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${s3Key}`;
    //CH6 L6 Signed URL - only store the s3 key in the db
    // const s3Url = s3Key;
    // video = await dbVideoToSignedVideo(cfg, video);
    const s3Url = `${cfg.s3CfDistribution}/${s3Key}`;

    video.videoURL = s3Url;
    updateVideo(cfg.db, video);
  } catch (error) {
    console.log("Video upload failed: S3 upload error", error);
    throw new Error("Failed to upload video to storage");
  }

  return respondWithJSON(200, null);
}

//CH4 L3 Object Storage Dynamic Path
export async function getVideoAspectRatio(filepath: string): Promise<string> {
  let result = "";

  console.log("Getting video aspect ratio for file:", filepath);

  // console.log("PATH:", process.env.PATH);

  //TESTING
  // console.log("proc2 process");
  // const proc2 = Bun.spawn(
  //   ["/usr/bin/ffprobe", "-v","error","-select_streams","v:0","-show_entries","stream=width,height","-of","json", filepath],
  //   { stdout: "pipe", stderr: "pipe" }
  // );

  console.log("proc process");
  const proc = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filepath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      onExit(subprocess, exitCode, signalCode, error) {
        if (exitCode !== 0) {
          console.error(`ffprobe failed with exit code ${exitCode}`);
        }
      },
    }
  );

  await proc.exited;

  const stdout = await new Response(proc.stdout).text();
  console.log("ffprobe stdout:", stdout);

  const stderr = await new Response(proc.stderr).text();
  console.log("ffprobe stderr:", stderr);

  if (proc.exitCode !== 0) {
    throw new Error(`ffprobe failed (${proc.exitCode}): ${stderr}`);
  }

  const data = JSON.parse(stdout);
  const s = data.streams[0];
  const w = Number(s.width);
  const h = Number(s.height);

  if (!Number.isFinite(w) || !Number.isFinite(h) || h === 0) {
    return "other";
  }

  const ratio = w / h;

  // tolerance for rounding
  if (Math.abs(ratio - 16 / 9) < 0.05) return "landscape";
  if (Math.abs(ratio - 9 / 16) < 0.05) return "portrait";
  return "other";
}

export async function processVideoForFastStart(
  inputFilePath: string
): Promise<string> {
  console.log("Processing video for fast start:", inputFilePath);

  if (!inputFilePath.endsWith(".mp4")) {
    throw new Error("Input file must be an mp4 file");
  }

  let outputFilePath = inputFilePath.replace(/.mp4$/i, ".processed.mp4");
  console.log("Output file path:", outputFilePath);

  const proc = Bun.spawn(
    [
      "ffmpeg",
      "-y",
      "-i",
      inputFilePath,
      "-map_metadata",
      "0",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-f",
      "mp4",
      outputFilePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      onExit(subprocess, exitCode, signalCode, error) {
        if (exitCode !== 0) {
          console.error(`ffmpeg failed with exit code ${exitCode}`);
        }
      },
    }
  );

  await proc.exited;

  const stdout = await new Response(proc.stdout).text();
  console.log("ffmpeg stdout:", stdout);

  const stderr = await new Response(proc.stderr).text();
  console.log("ffmpeg stderr:", stderr);

  if (proc.exitCode !== 0) {
    throw new Error(`ffmpeg failed (${proc.exitCode}): ${stderr}`);
  }

  return outputFilePath;
}



// export async function generatePresignedURL(
//   cfg: ApiConfig,
//   key: string,
//   expireTime: number
// ): Promise<string> {
//   const url = cfg.s3Client
//     .file(key, {
//       bucket: cfg.s3Bucket,
//     })
//     .presign({
//       expiresIn: expireTime,
//       method: "GET",
//       type: "video/mp4", // No extension for inferring, so we can specify the content type to be JSON
//     });

//   return url;
// }

// export async function dbVideoToSignedVideo(
//   cfg: ApiConfig,
//   video: Video
// ): Promise<Video> {
//   let signedVideo = { ...video };
//   if (!video.videoURL) return video;

//   signedVideo.videoURL = await generatePresignedURL(cfg, video.videoURL!, 3600); //3600 = 1 hour
//   return signedVideo;
// }
