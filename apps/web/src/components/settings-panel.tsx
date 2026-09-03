"use client";

import { ArrowLeft, Database, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { Toggle } from "@/components/ui/toggle";
import { memorySettingChecked } from "@/lib/memory-view";

export function SettingsPanel({
  settings,
  onClose,
  onSettings,
  onDeleteAll,
}: {
  settings: Record<string, boolean>;
  onClose: () => void;
  onSettings: (settings: Record<string, boolean>) => Promise<void>;
  onDeleteAll: (confirmation: string) => Promise<void>;
}) {
  const paused = settings.memoryEnabled === false;
  const [busySetting, setBusySetting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [deleting, setDeleting] = useState(false);

  async function updateSetting(key: string, checked: boolean) {
    if (busySetting) return;
    setBusySetting(key);
    setError(null);
    try {
      await onSettings({ [key]: checked });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "设置没有保存成功，请重试。");
    } finally {
      setBusySetting(null);
    }
  }

  async function deleteAll() {
    if (deleting || deleteConfirmation !== "删除知微中的全部数据") return;
    setDeleting(true);
    setError(null);
    try {
      await onDeleteAll(deleteConfirmation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "数据删除没有完成；你的数据仍然保留。");
      setDeleting(false);
    }
  }

  return (
    <main className="settings-shell">
      <header className="settings-header">
        <button onClick={onClose}><ArrowLeft size={18} />返回知微</button>
        <div><strong>设置</strong><span>记忆、陪伴方式与数据</span></div>
        <span aria-hidden="true" />
      </header>

      <div className="settings-scroll">
        <div className="settings-content">
          <section className="settings-intro">
            <span><ShieldCheck size={17} /></span>
            <div><h1>你的信息，由你决定</h1><p>你可以随时暂停记忆，或分别调整不同能力。暂停不会删除已有认识，也不会改动下方的分层偏好。</p></div>
          </section>

          {error ? <p className="settings-error" role="alert">{error}</p> : null}

          <section className="settings-card">
            <div className="settings-card-heading"><div><h2>记忆总开关</h2><p>控制知微是否记录和使用记忆与画像。</p></div><Database size={17} /></div>
            <div className={`settings-master ${paused ? "paused" : ""}`}>
              <span><strong>使用记忆与画像</strong><small>{paused ? "已暂停；当前了解度、近期与长期偏好均已保留" : "正在按照近期与长期偏好工作"}</small></span>
              <Toggle label="使用记忆与画像" checked={!paused} disabled={Boolean(busySetting)} onChange={(checked) => void updateSetting("memoryEnabled", checked)} />
            </div>
            {paused ? <p className="settings-pause-note">恢复后会继续沿用暂停前的近期与长期分层偏好；下方其他陪伴能力不受总开关影响。</p> : null}
          </section>

          <section className="settings-card">
            <div className="settings-card-heading"><div><h2>记忆分层偏好</h2><p>这些选择在记忆总开关暂停期间仍会原样保留。</p></div></div>
            <div className="settings-list">
              {([
                ["shortTermMemoryEnabled", "近期认识", "保留一段时间内仍有帮助的上下文"],
                ["longTermMemoryEnabled", "长期认识", "跨对话使用稳定的个人认识"],
              ] as const).map(([key, label, description]) => (
                <div className="settings-row" key={key}>
                  <span><strong>{label}</strong><small>{description}</small></span>
                  <Toggle label={label} checked={memorySettingChecked(settings, key)} disabled={Boolean(busySetting)} onChange={(checked) => void updateSetting(key, checked)} />
                </div>
              ))}
            </div>
          </section>

          <section className="settings-card">
            <div className="settings-card-heading"><div><h2>其他陪伴偏好</h2><p>以下能力独立生效，不受记忆总开关影响。</p></div></div>
            <div className="settings-list">
              {([
                ["emotionTrackingEnabled", "情绪趋势", "关闭后不再生成新的心情样本"],
                ["skillEvolutionEnabled", "相处方式学习", "关闭后保持目前学到的相处方式"],
                ["returnNotesEnabled", "站内回访", "关闭后不再展示未完话题提醒"],
              ] as const).map(([key, label, description]) => (
                <div className="settings-row" key={key}>
                  <span><strong>{label}</strong><small>{description}</small></span>
                  <Toggle label={label} checked={memorySettingChecked(settings, key)} disabled={Boolean(busySetting)} onChange={(checked) => void updateSetting(key, checked)} />
                </div>
              ))}
            </div>
          </section>

          <section className="settings-card settings-danger-card">
            <div className="settings-card-heading"><div><h2>删除全部数据</h2><p>永久清除当前知微档案的对话、画像、记忆、相处方式和运行记录。</p></div><Trash2 size={17} /></div>
            <label htmlFor="delete-all-confirmation">输入“删除知微中的全部数据”以确认</label>
            <input id="delete-all-confirmation" value={deleteConfirmation} onChange={(event) => setDeleteConfirmation(event.target.value)} placeholder="删除知微中的全部数据" />
            <button className="settings-delete-button" disabled={deleting || deleteConfirmation !== "删除知微中的全部数据"} onClick={() => void deleteAll()}>{deleting ? "正在删除…" : "永久删除全部数据"}</button>
          </section>
        </div>
      </div>
    </main>
  );
}
