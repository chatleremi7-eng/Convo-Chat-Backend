const { createClient } = require("@supabase/supabase-js");

let supabase = null;

function getSupabaseClient() {
  if (!supabase && process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
  return supabase;
}

async function uploadMedia(fileBuffer, fileName, contentType) {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error("Supabase client is not configured");
  }
  const filePath = `uploads/${Date.now()}_${fileName}`;
  const { data, error } = await client.storage
    .from("convo media")
    .upload(filePath, fileBuffer, { contentType, upsert: false });

  if (error) throw error;

  const { data: publicUrlData } = client.storage
    .from("convo media")
    .getPublicUrl(filePath);

  return publicUrlData.publicUrl;
}

async function uploadMediaFromBase64(base64Data, fileName, contentType) {
  const buffer = Buffer.from(base64Data, "base64");
  return uploadMedia(buffer, fileName, contentType);
}

module.exports = { getSupabaseClient, uploadMedia, uploadMediaFromBase64 };
