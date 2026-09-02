const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const logger = require('./logger');

const B2_KEY_ID = process.env.B2_KEY_ID || '005c2b526be0baa000000003f';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || 'K005yI4SsWuoMgX/VOuhJr/evjZsaQM';
const B2_BUCKET_NAME = process.env.B2_BUCKET_NAME || 'taxisapp';
const B2_ENDPOINT = process.env.B2_ENDPOINT || 'https://s3.us-east-005.backblazeb2.com';
const B2_REGION = process.env.B2_REGION || 'us-east-005';

let s3Client = null;

function getS3Client() {
  if (!s3Client) {
    s3Client = new S3Client({
      endpoint: B2_ENDPOINT.startsWith('http') ? B2_ENDPOINT : `https://${B2_ENDPOINT}`,
      region: B2_REGION,
      credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY
      }
    });
  }
  return s3Client;
}

/**
 * Sube un archivo directamente al bucket de Backblaze B2.
 * @param {Buffer} fileBuffer - Buffer del archivo en memoria.
 * @param {string} key - Ruta/clave dentro del bucket (ej. drivers/user123/license-1788.jpg)
 * @param {string} contentType - Tipo MIME del archivo (ej. image/jpeg, image/png)
 * @returns {Promise<string>} - URL pública del archivo en Backblaze B2
 */
async function uploadToB2(fileBuffer, key, contentType = 'image/jpeg') {
  try {
    const client = getS3Client();
    const command = new PutObjectCommand({
      Bucket: B2_BUCKET_NAME,
      Key: key,
      Body: fileBuffer,
      ContentType: contentType
    });

    await client.send(command);

    // Formato de URL pública estándar S3 compatible de Backblaze B2
    const cleanEndpoint = B2_ENDPOINT.replace(/^https?:\/\//, '');
    const publicUrl = `https://${B2_BUCKET_NAME}.${cleanEndpoint}/${key}`;

    logger.info(`📦 Archivo subido exitosamente a Backblaze B2: ${key}`);
    return publicUrl;
  } catch (error) {
    logger.error(`Error subiendo archivo a Backblaze B2 (${key}):`, error);
    throw error;
  }
}

module.exports = {
  getS3Client,
  uploadToB2,
  B2_BUCKET_NAME,
  B2_ENDPOINT,
  B2_REGION
};
