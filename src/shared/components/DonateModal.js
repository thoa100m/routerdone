"use client";

import { useEffect, useState, useRef } from "react";
import { createPortal } from "react-dom";
import PropTypes from "prop-types";
import { GITHUB_CONFIG } from "@/shared/constants/config";

function formatVnd(amount) {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

function buildVietQrUrl(channel, amount) {
  const query = new URLSearchParams({
    accountName: channel.accountName || "",
    addInfo: channel.content || "",
  });

  if (amount) query.set("amount", String(amount));

  return `https://img.vietqr.io/image/${channel.bankBin}-${channel.accountNo}-compact2.png?${query.toString()}`;
}

export default function DonateModal({ isOpen, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const modalRef = useRef(null);

  useEffect(() => {
    if (!isOpen || data) return;
    setLoading(true);
    setError("");
    fetch(GITHUB_CONFIG.donateUrl, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json) => setData(json))
      .catch((err) => setError(err.message || "Failed to load"))
      .finally(() => setLoading(false));
  }, [isOpen, data]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    };
    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={modalRef}
        className="relative w-full bg-surface border border-black/10 dark:border-white/10 rounded-xl shadow-2xl animate-in fade-in zoom-in-95 duration-200 max-w-3xl flex flex-col max-h-[85vh]"
      >
        <div className="flex items-center justify-between p-3 border-b border-black/5 dark:border-white/5">
          <h2 className="text-lg font-semibold text-text-main flex items-center gap-2">
            <span className="material-symbols-outlined text-pink-500">volunteer_activism</span>
            {data?.title || "Support RouterDone"}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Close"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        <div className="p-6 overflow-y-auto flex-1">
          {loading && (
            <div className="flex items-center justify-center py-10 text-text-muted">
              <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
              Loading...
            </div>
          )}
          {error && (
            <div className="text-red-500 py-4">Failed to load donate info: {error}</div>
          )}
          {!loading && !error && data && (
            <>
              {data.message && (
                <p className="text-text-muted text-sm mb-6 text-center">{data.message}</p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {data.channels?.map((ch) => (
                  <DonateChannelCard key={ch.id} channel={ch} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function DonateChannelCard({ channel }) {
  const { label, description, icon, color, url, qr } = channel;
  const [copied, setCopied] = useState("");
  const [selectedAmount, setSelectedAmount] = useState(channel.defaultAmount || channel.amounts?.[0] || 0);
  const isVietQr = channel.type === "vietqr";
  const qrUrl = isVietQr ? buildVietQrUrl(channel, selectedAmount) : qr;

  const copyValue = async (key, value) => {
    if (!value) return;
    await navigator.clipboard?.writeText(String(value));
    setCopied(key);
    window.setTimeout(() => setCopied(""), 1200);
  };

  const content = (
    <>
      <div
        className="w-12 h-12 rounded-full flex items-center justify-center mb-3"
        style={{ backgroundColor: `${color}20`, color }}
      >
        <span className="material-symbols-outlined text-[26px]">{icon}</span>
      </div>
      <div className="font-semibold text-text-main mb-1">{label}</div>
      {description && (
        <div className="text-xs text-text-muted mb-3 text-center">{description}</div>
      )}
      {qrUrl && (
        <img
          src={qrUrl}
          alt={`${label} QR`}
          className="w-full max-w-[180px] aspect-square object-contain rounded-lg bg-white p-1"
        />
      )}
      {isVietQr && (
        <div className="mt-3 w-full space-y-3">
          {channel.amounts?.length > 0 && (
            <div className="grid grid-cols-3 gap-1.5">
              {channel.amounts.map((amount) => (
                <button
                  key={amount}
                  type="button"
                  onClick={() => setSelectedAmount(amount)}
                  className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                    selectedAmount === amount
                      ? "border-transparent text-white"
                      : "border-black/10 dark:border-white/10 text-text-muted hover:text-text-main"
                  }`}
                  style={selectedAmount === amount ? { backgroundColor: color } : undefined}
                >
                  {formatVnd(amount).replace("₫", "đ")}
                </button>
              ))}
            </div>
          )}
          <div className="space-y-1.5 text-xs">
            <CopyRow
              label="Bank"
              value={channel.bankName}
              copied={copied === "bank"}
              onCopy={() => copyValue("bank", channel.bankName)}
            />
            <CopyRow
              label="Account"
              value={channel.accountNo}
              copied={copied === "account"}
              onCopy={() => copyValue("account", channel.accountNo)}
            />
            <CopyRow
              label="Name"
              value={channel.accountName}
              copied={copied === "name"}
              onCopy={() => copyValue("name", channel.accountName)}
            />
            <CopyRow
              label="Content"
              value={channel.content}
              copied={copied === "content"}
              onCopy={() => copyValue("content", channel.content)}
            />
          </div>
        </div>
      )}
    </>
  );

  return (
    <div className="flex flex-col items-center p-4 rounded-xl border border-black/10 dark:border-white/10 bg-surface/50 hover:border-pink-500/40 transition-colors">
      {content}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-sm font-medium text-white hover:opacity-90 transition-opacity"
          style={{ backgroundColor: color }}
        >
          Open
          <span className="material-symbols-outlined text-[16px]">open_in_new</span>
        </a>
      )}
    </div>
  );
}

function CopyRow({ label, value, copied, onCopy }) {
  return (
    <button
      type="button"
      onClick={onCopy}
      className="flex w-full items-center justify-between gap-2 rounded-lg bg-black/[0.03] px-2.5 py-1.5 text-left hover:bg-black/[0.06] dark:bg-white/[0.04] dark:hover:bg-white/[0.08]"
    >
      <span className="shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 flex-1 truncate font-medium text-text-main">{value}</span>
      <span className="material-symbols-outlined text-[15px] text-text-muted">
        {copied ? "check" : "content_copy"}
      </span>
    </button>
  );
}

DonateModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
};
