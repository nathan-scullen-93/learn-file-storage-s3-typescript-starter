import { respondWithJSON } from "./json";

import { type ApiConfig } from "../config";
import { s3, write, type BunRequest, type S3File } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { getBearerToken, validateJWT } from "../auth";
import { randomBytes, type UUID } from "crypto";
import { getVideo, updateVideo } from "../db/videos";
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

  const video = getVideo(cfg.db, videoId);
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

  //Copy the file to s3 storage
  const metadata = s3.file(`${randBytes}.${fileExtension}`);

  try {
    await metadata.write(Bun.file(localPath), {
      type: "video/mp4",
    });
    //Remove the temp video file after processing
    await Bun.file(localPath).delete();

//Update the videoURL in the database
  const s3Url = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${randBytes}.${fileExtension}`;
  video.videoURL = s3Url;
  updateVideo(cfg.db, video);

  } catch (error) {
    console.log("Video upload failed: S3 upload error", error);
    throw new Error("Failed to upload video to storage");
  }

  return respondWithJSON(200, null);
}
