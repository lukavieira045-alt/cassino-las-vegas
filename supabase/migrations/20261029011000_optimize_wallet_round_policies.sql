-- Pequena otimização para as consultas do histórico e carteiras.
CREATE INDEX IF NOT EXISTS idx_cassino_slot_rounds_user_id
  ON public.cassino_slot_rounds (user_id);

ALTER POLICY "Players can view their own slot rounds"
  ON public.cassino_slot_rounds
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "players read own game rounds"
  ON public.cassino_game_rounds
  USING ((SELECT auth.uid()) = user_id);

ALTER POLICY "Users can read own test wallet"
  ON public.test_wallets
  USING ((SELECT auth.uid()) = user_id);
