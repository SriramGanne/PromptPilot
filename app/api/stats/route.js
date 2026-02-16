import { NextResponse } from "next/server";
import { supabase } from "../../../lib/supabase";

/* ── In-memory cache (5 min TTL) ── */
let cache = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes in ms

export async function GET() {
  // Return cached data if fresh
  const now = Date.now();
  if (cache && now - cacheTimestamp < CACHE_TTL) {
    return NextResponse.json(cache);
  }

  try {
    // Run all queries in parallel
    const [countRes, avgRes, savedRes, modelRes] = await Promise.all([
      // Total optimizations
      supabase
        .from("prompt_metrics")
        .select("*", { count: "exact", head: true }),

      // Average reduction percent
      supabase.rpc("avg_reduction"),

      // Total tokens saved (original - optimized)
      supabase.rpc("total_tokens_saved"),

      // Most used target model
      supabase.rpc("most_used_model"),
    ]);

    const stats = {
      totalOptimizations: countRes.count ?? 0,
      avgReduction: Math.round(avgRes.data ?? 0),
      totalTokensSaved: savedRes.data ?? 0,
      mostUsedModel: modelRes.data ?? "—",
    };

    // Update cache
    cache = stats;
    cacheTimestamp = now;

    return NextResponse.json(stats);
  } catch (err) {
    console.error("Stats error:", err);

    // Return stale cache if available, otherwise zeros
    if (cache) return NextResponse.json(cache);

    return NextResponse.json(
      {
        totalOptimizations: 0,
        avgReduction: 0,
        totalTokensSaved: 0,
        mostUsedModel: "—",
      },
      { status: 500 }
    );
  }
}
