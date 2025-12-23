import React, { useState } from 'react';
import { Sparkles, ArrowRight, Loader2, Bot, Layout, Award, CheckCircle2, Settings, History } from 'lucide-react';
import clsx from 'clsx';
import { FileUpload } from './components/FileUpload';
import { ReportView } from './components/ReportView';
import { SettingsModal } from './components/SettingsModal';
import { HistoryView } from './components/HistoryView';
import { evaluateFiles } from './api';

function App() {
  const [teacherDoc, setTeacherDoc] = useState(null);
  const [dialogueRecord, setDialogueRecord] = useState(null);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [step, setStep] = useState('upload'); // upload, processing, results
  const [currentView, setCurrentView] = useState('main'); // main, history
  const [showSettings, setShowSettings] = useState(false);

  const handleStartEvaluation = async () => {
    if (!teacherDoc || !dialogueRecord) return;

    setStep('processing');
    setLoading(true);
    setError(null);

    try {
      // Load API config from localStorage
      const savedSettings = localStorage.getItem('llm-eval-settings');
      const apiConfig = savedSettings ? JSON.parse(savedSettings) : {};

      const result = await evaluateFiles(teacherDoc, dialogueRecord, apiConfig);
      setReport(result);
      setStep('results');
    } catch (err) {
      setError(err.message);
      setStep('upload');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    setTeacherDoc(null);
    setDialogueRecord(null);
    setReport(null);
    setStep('upload');
    setError(null);
  };

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-900 font-sans selection:bg-indigo-100 selection:text-indigo-900 relative overflow-x-hidden">

      {/* Abstract Background Shapes */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute -top-[20%] -left-[10%] w-[70vw] h-[70vw] bg-indigo-200/20 rounded-full blur-[120px] mix-blend-multiply opacity-60 animate-blob" />
        <div className="absolute top-[20%] -right-[10%] w-[60vw] h-[60vw] bg-purple-200/20 rounded-full blur-[120px] mix-blend-multiply opacity-60 animate-blob animation-delay-2000" />
        <div className="absolute -bottom-[20%] left-[20%] w-[60vw] h-[60vw] bg-blue-200/20 rounded-full blur-[120px] mix-blend-multiply opacity-60 animate-blob animation-delay-4000" />
      </div>

      <div className="relative z-10 w-full min-h-screen flex flex-col">

        {/* Glass Navbar */}
        <nav className="w-full px-8 py-5 flex items-center justify-between backdrop-blur-md bg-white/70 sticky top-0 border-b border-white/50 z-50">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-gradient-to-tr from-indigo-600 to-violet-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-indigo-500/20 ring-1 ring-black/5">
              <Bot className="w-6 h-6" />
            </div>
            <span className="font-extrabold text-2xl tracking-tight text-slate-800">
              Agent<span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 to-violet-600">Eval</span>
            </span>
          </div>
          <div className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-500">
            <button
              onClick={() => setCurrentView('history')}
              className="hover:text-indigo-600 transition-colors cursor-pointer flex items-center gap-2"
            >
              <History className="w-4 h-4" />
              History
            </button>
            <button
              onClick={() => setShowSettings(true)}
              className="hover:text-indigo-600 transition-colors cursor-pointer flex items-center gap-2"
            >
              <Settings className="w-4 h-4" />
              Settings
            </button>
            <div className="w-px h-4 bg-slate-300 mx-2" />
            <div className="flex items-center gap-2 px-3 py-1.5 bg-white rounded-full border border-slate-200 shadow-sm">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-slate-700">System Ready</span>
            </div>
          </div>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 w-full max-w-7xl mx-auto p-4 md:p-8 lg:p-12 flex flex-col items-center justify-start pt-12 md:pt-20">

          {/* Settings Modal */}
          <SettingsModal isOpen={showSettings} onClose={() => setShowSettings(false)} />

          {/* Conditional View Rendering */}
          {currentView === 'history' ? (
            <HistoryView onBack={() => setCurrentView('main')} />
          ) : (
            <>
              {step === 'upload' && (
                <div className="w-full grid lg:grid-cols-2 gap-16 items-center animate-in fade-in slide-in-from-bottom-8 duration-700">

                  {/* Left Column: Headline & Info */}
                  <div className="space-y-8 text-center lg:text-left">
                    <div className="space-y-4">
                      <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-700 font-semibold text-sm">
                        <Sparkles className="w-4 h-4" />
                        <span>AI-Powered Assessment Engine</span>
                      </div>
                      <h1 className="text-5xl md:text-6xl font-black text-slate-900 leading-[1.1] tracking-tight">
                        Evaluate your <br />
                        <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-600 via-violet-600 to-purple-600">
                          Intelligent Agent
                        </span>
                      </h1>
                      <p className="text-xl text-slate-600 max-w-xl mx-auto lg:mx-0 leading-relaxed">
                        Upload your teacher guidelines and dialogue records to get a comprehensive, multi-dimensional performance analysis in seconds.
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      {[
                        { icon: Layout, label: 'Structure Analysis', desc: 'Checks workflow compliance' },
                        { icon: Award, label: 'Quality Scoring', desc: '6-Dimension Evaluation' },
                        { icon: CheckCircle2, label: 'Instant Feedback', desc: 'Actionable suggestions' },
                      ].map((feature, i) => (
                        <div key={i} className="p-4 rounded-2xl bg-white/50 border border-white/60 hover:bg-white transition-colors">
                          <feature.icon className="w-6 h-6 text-indigo-600 mb-3" />
                          <h3 className="font-bold text-slate-800 text-sm mb-1">{feature.label}</h3>
                          <p className="text-xs text-slate-500 leading-snug">{feature.desc}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Right Column: Upload Card */}
                  <div className="relative w-full max-w-lg mx-auto">
                    <div className="absolute inset-0 bg-gradient-to-tr from-indigo-500 to-purple-500 rounded-3xl blur-2xl opacity-20 transform translate-y-4" />
                    <div className="relative bg-white/80 backdrop-blur-xl rounded-3xl p-8 shadow-2xl shadow-slate-200/50 border border-white/60 ring-1 ring-slate-100">
                      <div className="space-y-8">
                        <FileUpload
                          header="1. Teacher Document"
                          label="Upload .docx or .md guidelines"
                          accept=".docx,.md,.txt"
                          onFileSelect={setTeacherDoc}
                        />

                        <div className="relative flex items-center justify-center">
                          <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-slate-200" />
                          </div>
                          <div className="relative bg-slate-50 px-4 py-1 rounded-full text-xs font-semibold text-slate-400 uppercase tracking-wider">
                            AND
                          </div>
                        </div>

                        <FileUpload
                          header="2. Dialogue Record"
                          label="Upload .json conversation logs"
                          accept=".json,.txt"
                          onFileSelect={setDialogueRecord}
                        />

                        {error && (
                          <div className="p-4 bg-red-50 text-red-700 rounded-xl text-sm flex items-start gap-3 border border-red-100">
                            <div className="mt-0.5 min-w-[16px]"><Layout className="w-4 h-4 rotate-45" /></div>
                            <p>{error}</p>
                          </div>
                        )}

                        <button
                          onClick={handleStartEvaluation}
                          disabled={!teacherDoc || !dialogueRecord}
                          className={clsx(
                            "group w-full py-4 rounded-xl text-lg font-bold transition-all duration-300 flex items-center justify-center gap-3 shadow-lg hover:shadow-xl hover:-translate-y-0.5 active:translate-y-0 relative overflow-hidden",
                            (teacherDoc && dialogueRecord)
                              ? "bg-slate-900 text-white hover:bg-slate-800"
                              : "bg-slate-100 text-slate-400 cursor-not-allowed"
                          )}
                        >
                          {/* Shimmer effect */}
                          {(teacherDoc && dialogueRecord) && (
                            <div className="absolute inset-0 -translate-x-full group-hover:animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent z-0" />
                          )}
                          <span className="relative z-10 flex items-center gap-2">
                            Start Evaluation <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
                          </span>
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {step === 'processing' && (
                <div className="flex-1 flex flex-col items-center justify-center min-h-[60vh] animate-in fade-in duration-700">
                  <div className="relative w-40 h-40 mb-12">
                    <div className="absolute inset-0 bg-indigo-500/10 rounded-full animate-ping opacity-75" />
                    <div className="absolute inset-4 bg-white rounded-full shadow-2xl flex items-center justify-center z-10">
                      <Bot className="w-16 h-16 text-indigo-600 animate-bounce" />
                    </div>
                    <svg className="absolute inset-0 w-full h-full rotate-[-90deg]" viewBox="0 0 100 100">
                      <circle cx="50" cy="50" r="46" fill="none" stroke="#e2e8f0" strokeWidth="8" />
                      <circle cx="50" cy="50" r="46" fill="none" stroke="#4f46e5" strokeWidth="8" strokeDasharray="290" strokeDashoffset="100" className="animate-[dash_2s_ease-in-out_infinite]" strokeLinecap="round" />
                    </svg>
                  </div>

                  <h2 className="text-4xl font-black text-slate-800 mb-4 tracking-tight text-center">
                    Analysing Performance
                  </h2>
                  <div className="flex flex-col gap-2 items-center text-slate-500 text-lg">
                    <p className="animate-pulse">Reading teacher guidelines...</p>
                    <p className="animate-[pulse_1.5s_ease-in-out_0.5s_infinite]">Evaluating dialogue context...</p>
                    <p className="animate-[pulse_1.5s_ease-in-out_1s_infinite]">Calculating dimensional scores...</p>
                  </div>
                </div>
              )}

              {step === 'results' && (
                <ReportView report={report} onReset={handleReset} />
              )}

            </>
          )}

        </main>

      </div>
    </div>
  );
}

export default App;
