import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabase = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) return json({ error: "يجب تسجيل الدخول أولًا." }, 401);

    const body = await req.json();
    const provider = body.provider === "gemini" ? "gemini" : "chatgpt";
    const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
    if (!messages.length || messages.some((m: any) => !["user", "assistant"].includes(m.role) || typeof m.content !== "string")) {
      return json({ error: "صيغة المحادثة غير صحيحة." }, 400);
    }
    const system = "You are Study Quest, a helpful study assistant for a high-school student. Explain clearly, encourage learning, and answer in the language the student uses. Do not provide harmful or age-inappropriate content.";
    let reply = "";

    if (provider === "chatgpt") {
      const key = Deno.env.get("OPENAI_API_KEY");
      if (!key) return json({ error: "مفتاح ChatGPT غير مضبوط في إعدادات Supabase بعد." }, 503);
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          instructions: system,
          input: messages.map((m: any) => ({ role: m.role, content: [{ type: "input_text", text: m.content }] })),
          max_output_tokens: 900,
        }),
      });
      const result = await response.json();
      if (!response.ok) return json({ error: result.error?.message || "تعذر الاتصال بـ ChatGPT." }, response.status);
      reply = result.output?.flatMap((item: any) => item.content || []).filter((part: any) => part.type === "output_text").map((part: any) => part.text).join("\n") || "";
    } else {
      const key = Deno.env.get("GEMINI_API_KEY");
      if (!key) return json({ error: "مفتاح Gemini غير مضبوط في إعدادات Supabase بعد." }, 503);
      const contents = messages.map((m: any) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(key), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: 900 } }),
      });
      const result = await response.json();
      if (!response.ok) return json({ error: result.error?.message || "تعذر الاتصال بـ Gemini." }, response.status);
      reply = result.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
    }

    if (!reply) return json({ error: "لم يصل رد من النموذج. حاول مرة أخرى." }, 502);
    return json({ reply });
  } catch (_error) {
    return json({ error: "حدث خطأ غير متوقع أثناء تشغيل المساعد." }, 500);
  }
});
