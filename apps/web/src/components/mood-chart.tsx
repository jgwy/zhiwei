"use client";

import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from "recharts";
import type { BootstrapData } from "@/lib/client-types";

export function MoodChart({ mood }: { mood: BootstrapData["mood"] }) {
  return (
    <ResponsiveContainer width="100%" height={118}>
      <LineChart data={mood} margin={{ top: 14, right: 8, bottom: 4, left: 8 }}>
        <YAxis domain={[-5, 5]} hide />
        <Tooltip
          contentStyle={{ borderRadius: 12, border: "1px solid #e8e8e8", boxShadow: "0 10px 30px rgba(0,0,0,.08)", fontSize: 12 }}
          labelFormatter={(value) => new Date(String(value ?? "")).toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}
        />
        <Line name="心情值" type="monotone" dataKey="score" stroke="#222" strokeWidth={2.2} dot={{ r: 3, fill: "white", strokeWidth: 2 }} activeDot={{ r: 4 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}
