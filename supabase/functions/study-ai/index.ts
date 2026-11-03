import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey =
      Deno.env.get("SUPABASE_ANON_KEY") ||
      Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      return json({ error: "Supabase environment variables are missing." }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return json({ error: "يجب تسجيل الدخول أولًا." }, 401);
    }

    const body = await req.json();
    const messages = Array.isArray(body.messages)
      ? body.messages.slice(-12)
      : [];

    if (
      !messages.length ||
      messages.some(
        (m: any) =>
          !["user", "assistant"].includes(m.role) ||
          typeof m.content !== "string"
      )
    ) {
      return json({ error: "صيغة المحادثة غير صحيحة." }, 400);
    }

    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) {
      return json({ error: "مفتاح Gemini غير مضبوط في إعدادات Supabase." }, 503);
    }

    const system =
      "You are Study Quest, a helpful study assistant for a high-school student. Explain clearly, encourage learning, and answer in the language the student uses. Do not provide harmful or age-inappropriate content.";

    const contents = messages.map((m: any) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=" +
      encodeURIComponent(key);

    const requestBody = JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents,
      generationConfig: { maxOutputTokens: 900 },
    });

    let response: Response | null = null;
    let lastNetworkError: unknown = null;

    // Retry temporary capacity, rate-limit, and gateway errors with exponential backoff.
    const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        });
        if (!retryableStatuses.has(response.status) || attempt === 4) break;
        const delay = Math.min(1000 * 2 ** attempt, 16000) + Math.floor(Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error) {
        lastNetworkError = error;
        if (attempt === 4) break;
        const delay = Math.min(1000 * 2 ** attempt, 16000) + Math.floor(Math.random() * 500);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (!response) {
      console.error("Gemini network request failed:", lastNetworkError);
      return json({ error: "تعذر الوصول إلى Gemini بعد عدة محاولات. جرّب مرة أخرى بعد قليل." }, 503);
    }

    const result = await response.json();

    if (!response.ok) {
      return json(
        { error: result.error?.message || "تعذر الاتصال بـ Gemini." },
        response.status
      );
    }

    const reply =
      result.candidates?.[0]?.content?.parts
        ?.map((part: any) => part.text || "")
        .join("") || "";

    if (!reply) {
      return json({ error: "لم يصل رد من Gemini. حاول مرة أخرى." }, 502);
    }

    return json({ reply });
  } catch (_error) {
    return json(
      { error: "حدث خطأ غير متوقع أثناء تشغيل المساعد." },
      500
    );
  }
});
