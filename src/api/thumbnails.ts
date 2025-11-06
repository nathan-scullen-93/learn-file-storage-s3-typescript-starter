import { getBearerToken, validateJWT } from "../auth";
import { respondWithJSON } from "./json";
import { getVideo, updateVideo } from "../db/videos";
import type { ApiConfig } from "../config";
import type { BunRequest } from "bun";
import { BadRequestError, NotFoundError, UserForbiddenError } from "./errors";
import { JsonWebTokenError } from "jsonwebtoken";
import path from "path";

type Thumbnail = {
  data: ArrayBuffer;
  mediaType: string;
};

const videoThumbnails: Map<string, Thumbnail> = new Map();

// export async function handlerGetThumbnail(cfg: ApiConfig, req: BunRequest) {
//   const { videoId } = req.params as { videoId?: string };
//   if (!videoId) {
//     throw new BadRequestError("Invalid video ID");
//   }

//   const video = getVideo(cfg.db, videoId);
//   if (!video) {
//     throw new NotFoundError("Couldn't find video");
//   }

//   const thumbnail = videoThumbnails.get(videoId);
//   if (!thumbnail) {
//     throw new NotFoundError("Thumbnail not found");
//   }

//   return new Response(thumbnail.data, {
//     headers: {
//       "Content-Type": thumbnail.mediaType,
//       "Cache-Control": "no-store",
//     },
//   });
// }

export async function handlerUploadThumbnail(cfg: ApiConfig, req: BunRequest) {
  const { videoId } = req.params as { videoId?: string };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);

  console.log("uploading thumbnail for video", videoId, "by user", userID);

  const thumbnailFile = (await req.formData()).get("thumbnail");
  if (!thumbnailFile || !(thumbnailFile instanceof File)) {
    throw new BadRequestError("thumbnail is required");
  }

  console.log(
    `Thumbnail recieved: ${thumbnailFile.name} ${thumbnailFile.size} ${thumbnailFile.type}`
  );

  if (
    thumbnailFile.type !== "image/png" &&
    thumbnailFile.type !== "image/jpeg"
  ) {
    console.log("Thumbnail upload failed: invalid file type");
    throw new BadRequestError("Thumbnail must be a PNG or JPEG image");
  }

  const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

  if (thumbnailFile.size > MAX_UPLOAD_SIZE) {
    console.log("Thumbnail upload failed: file size exceeds limit");
    throw new BadRequestError("Thumbnail file size exceeds the maximum limit");
  }

  const mediaType = thumbnailFile.type;
  const filetypeParts = mediaType.split("/");
  const fileExtension = filetypeParts[filetypeParts.length - 1];
  // const data = await Buffer.from(await thumbnailFile.arrayBuffer()).toBase64();
  const data = await thumbnailFile.arrayBuffer();

  const video = getVideo(cfg.db, videoId);
  if (!video) {
    console.log("Thumbnail upload failed: video not found");
    throw new NotFoundError("Couldn't find video");
  }

  if (
    video.userID !== validateJWT(getBearerToken(req.headers), cfg.jwtSecret)
  ) {
    console.log("Thumbnail upload failed: user forbidden");
    throw new UserForbiddenError(
      "You do not have permission to access this thumbnail"
    );
  }

  // video.thumbnailURL =  `data:${mediaType};base64,${data}`;
  video.thumbnailURL = `http://localhost:${cfg.port}/assets/${videoId}.${fileExtension}`;

  console.log("Updating video metadata with thumbnail URL");
  updateVideo(cfg.db, video);

  const localPath = path.join(cfg.assetsRoot, `${videoId}.${fileExtension}`);

  await Bun.write(localPath, data);

  //videoThumbnails.set(videoId, { data, mediaType });
  console.log("Thumbnail upload successful");
  return respondWithJSON(200, video);
}
