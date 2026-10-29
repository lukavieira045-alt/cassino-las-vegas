import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: cors });

const themeSymbols: Record<string, string[]> = {
  vegas: ["🎰","💎","7️⃣","⭐","🍒","🔔","👑"],
  rabbit: ["🐰","🥕","🌸","🪙","💎","⭐","🎁"],
  tiger: ["🐯","🐅","🪙","💰","💎","⭐","🏮"],
  snake: ["🐍","💚","🌿","🪙","💎","⭐","🐉"],
  dragon: ["🐉","🔥","🧧","🪙","💎","⭐","👑"],
  ox: ["🐂","🐃","🪙","💰","💎","⭐","🏆"],
  treasure: ["🏺","🪙","💰","👑","💎","⭐","🔱"],
  pinata: ["🪅","🎉","🍬","🎊","💎","⭐","🎁"],
  rabbit2: ["🐇","🌙","🥕","🪙","💎","⭐","🌸"],
  joker: ["🃏","🎭","♠️","♥️","💎","⭐","👑"],
  mouse: ["🐭","🧀","🪙","💰","💎","⭐","🎩"],
  bass: ["🐟","🎣","🌊","🪙","💎","⭐","🛥️"],
  bandito: ["🤠","🌵","🔫","🪙","💎","⭐","🌶️"],
  coco: ["💀","🌺","🪙","💰","💎","⭐","🏆"],
  luckybox: ["🎁","🧸","🌈","🪙","💎","⭐","🎉"]
};
const themeLabels: Record<string, string> = {
  vegas:"Mega Vegas", rabbit:"Fortune Rabbit", tiger:"Fortune Tiger", snake:"Fortune Snake",
  dragon:"Fortune Dragon", ox:"Fortune Ox", treasure:"Treasure Bowl X-Huge", pinata:"Pinata Wins",
  rabbit2:"Fortune Rabbit 2", joker:"Joker's Jewels", mouse:"Fortune Mouse", bass:"Big Bass Splash",
  bandito:"Wild Bandito", coco:"Coco's Riches", luckybox:"Labubu's Lucky Box"
};
function secureIndex(max: number): number {
  const limit = Math.floor(256 / max) * max;
  const b = new Uint8Array(1);
  do { crypto.getRandomValues(b); } while (b[0] >= limit);
  return b[0] % max;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  try {
    const body = await req.json().catch(() => null);
    const testMode = body?.test_mode === true;
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !anonKey || !serviceKey) return reply({ error: "Configuração do servidor incompleta." }, 503);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return reply({ error: "Faça login antes de jogar." }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return reply({ error: "Sessão inválida. Entre novamente." }, 401);

    const stakeCents = Number(body?.stake_cents);
    if (!Number.isInteger(stakeCents) || ![50, 100, 200, 500, 1000, 2000, 5000, 10000].includes(stakeCents)) {
      return reply({ error: "Aposta inválida. Escolha R$ 0,50, R$ 1, R$ 2, R$ 5, R$ 10, R$ 20, R$ 50 ou R$ 100." }, 400);
    }

    const themeId = String(body?.theme_id || "vegas");
    const symbols = themeSymbols[themeId];
    if (!symbols) return reply({ error: "Tema de jogo inválido." }, 400);
    const grid = Array.from({ length: 3 }, () =>
      Array.from({ length: 5 }, () => symbols[secureIndex(symbols.length)])
    );
    const roundId = crypto.randomUUID();
    const admin = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    if (testMode) {
      if (!["66b95d54-d754-46ba-afbc-fa713c61e8df", "68be2506-c1e9-484c-853d-015afadbd21a"].includes(authData.user.id)) return reply({ error: "Modo de teste não autorizado." }, 403);
      const won = grid[0].every(v => v === grid[0][0]);
      const payout = won ? stakeCents * 2 : 0;
      const { data: testData, error: testError } = await admin.rpc("settle_cassino_test_round", { p_user_id: authData.user.id, p_round_id: roundId, p_game_key: "royal_slots", p_stake_cents: stakeCents, p_payout_cents: payout, p_result: { grid } });
      if (testError) return reply({ error: /Insufficient test balance/i.test(testError.message) ? "Saldo de teste insuficiente." : "Não foi possível concluir o giro de teste." }, 409);
      return reply({ ...testData, grid, won, payout: payout / 100, balance: testData.balance, test_mode: true });
    }
    const { data, error } = await admin.rpc("settle_cassino_slot_spin", {
      p_user_id: authData.user.id,
      p_round_id: roundId,
      p_stake_cents: stakeCents,
      p_grid: grid,
      p_theme_id: themeId,
    });
    if (error) {
      const msg = error.message || "";
      if (/Insufficient balance/i.test(msg)) return reply({ error: "Saldo real insuficiente para essa aposta." }, 409);
      if (/Wallet not found/i.test(msg)) return reply({ error: "Sua carteira ainda não está pronta. Atualize o perfil e tente novamente." }, 409);
      console.error("Slot settlement failed", msg);
      return reply({ error: "Não foi possível concluir o giro. O saldo não foi alterado se a transação falhou." }, 500);
    }
    return reply({ ok: true, ...data, grid, theme_id: themeId, theme_name: themeLabels[themeId] });
  } catch (error) {
    console.error("Slot spin error", error instanceof Error ? error.message : "unknown");
    return reply({ error: "Erro interno ao girar a máquina." }, 500);
  }
});