import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}
const allowedAmounts = [5, 10, 20, 30, 40, 50, 60, 100, 200, 300, 500, 1000];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST." }, 405);
  if (Deno.env.get("CASSINO_REAL_MONEY_ENABLED") !== "true") {
    return reply({ error: "Depósitos em dinheiro real estão temporariamente bloqueados no servidor. Nenhum depósito foi criado." }, 423);
  }
  try {
    const token = Deno.env.get("MERCADO_PAGO_ACCESS_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!token || !supabaseUrl || !anonKey || !serviceKey) return reply({ error: "Configuração do servidor incompleta." }, 503);
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return reply({ error: "Faça login antes de depositar." }, 401);
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) return reply({ error: "Sessão inválida. Entre novamente." }, 401);
    const body = await req.json().catch(() => null);
    const amount = Number(body?.amount);
    if (!Number.isFinite(amount) || !allowedAmounts.includes(amount)) return reply({ error: "Valor inválido. Escolha um dos valores exibidos." }, 400);
    const payerEmail = String(body?.payer_email ?? "").trim().toLowerCase();
    if (!payerEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) return reply({ error: "Informe um e-mail válido para gerar o Pix. Ele será usado somente nesta cobrança, não no cadastro." }, 422);
    const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: deposit, error: insertError } = await admin.from("deposits")
      .insert({ user_id: authData.user.id, amount, currency: "BRL", provider: "mercado_pago", status: "pending" })
      .select("id, amount, currency").single();
    if (insertError || !deposit) {
      console.error("Could not create pending deposit", insertError?.message);
      return reply({ error: "Não foi possível iniciar o depósito." }, 500);
    }
    const mpResponse = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({
        transaction_amount: amount,
        description: "Depósito de carteira — Cassino Las Vegas",
        payment_method_id: "pix",
        payer: { email: payerEmail },
        external_reference: String(deposit.id),
        notification_url: `${supabaseUrl}/functions/v1/mercado-pago-webhook-cassino`,
        metadata: { deposit_id: String(deposit.id), user_id: authData.user.id },
      }),
    });
    const payment = await mpResponse.json().catch(() => ({}));
    try {
      const meResponse = await fetch("https://api.mercadopago.com/users/me", { headers: { Authorization: `Bearer ${token}` } });
      const me = await meResponse.json().catch(() => ({}));
      console.log("MP_RECEIVER_DIAGNOSTIC", JSON.stringify({ payment_id: payment.id ?? null, payment_collector_id: payment.collector_id ?? null, token_account_id: me.id ?? null, token_account_nickname: me.nickname ?? null, token_account_status: meResponse.status }));
    } catch (diagnosticError) {
      console.warn("MP_RECEIVER_DIAGNOSTIC_FAILED", diagnosticError instanceof Error ? diagnosticError.message : "unknown");
    }
    const pix = payment?.point_of_interaction?.transaction_data;
    if (!mpResponse.ok || !payment?.id || !pix?.qr_code || !pix?.qr_code_base64) {
      console.error("Mercado Pago Pix creation error", mpResponse.status, payment?.message ?? payment?.cause?.[0]?.description ?? "unknown");
      await admin.from("deposits").update({ status: "rejected" }).eq("id", deposit.id).eq("status", "pending");
      return reply({ error: payment?.message || payment?.cause?.[0]?.description || "Mercado Pago não conseguiu gerar o QR Code Pix. Confira a conta e as credenciais." }, 502);
    }
    await admin.from("deposits").update({ provider_payment_id: String(payment.id) }).eq("id", deposit.id);
    const rawTicketUrl = typeof pix.ticket_url === "string" ? pix.ticket_url : "";
    let ticket_url: string | null = null;
    try {
      const ticket = new URL(rawTicketUrl);
      if (ticket.protocol === "https:" && (ticket.hostname === "mercadopago.com.br" || ticket.hostname.endsWith(".mercadopago.com.br"))) ticket_url = ticket.href;
    } catch { /* no valid official ticket URL */ }
    return reply({
      ok: true,
      deposit_id: deposit.id,
      amount: deposit.amount,
      payment_id: String(payment.id),
      qr_code: pix.qr_code,
      qr_code_base64: pix.qr_code_base64,
      ticket_url,
      status: payment.status || "pending",
      message: "QR Code Pix criado pelo Mercado Pago. Se o banco recusar o copia e cola, tente abrir a página oficial da cobrança.",
    }, 201);
  } catch (error) {
    console.error("Pix deposit creation error", error instanceof Error ? error.message : "unknown");
    return reply({ error: "Erro interno ao iniciar depósito Pix." }, 500);
  }
});