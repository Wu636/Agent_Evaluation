import React, { useCallback, useState } from 'react';
import { Upload, FileText, X, CheckCircle, FileUp } from 'lucide-react';
import clsx from 'clsx';

export function FileUpload({ label, accept, onFileSelect, header }) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFile, setSelectedFile] = useState(null);

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      validateAndSetFile(files[0]);
    }
  };

  const handleFileInput = (e) => {
    if (e.target.files?.length > 0) {
      validateAndSetFile(e.target.files[0]);
    }
  };

  const validateAndSetFile = (file) => {
    setSelectedFile(file);
    onFileSelect(file);
  };

  const removeFile = () => {
    setSelectedFile(null);
    onFileSelect(null);
  };

  return (
    <div className="w-full">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-slate-600 text-xs font-bold border border-slate-200">
          {header.split('.')[0]}
        </div>
        <h3 className="text-sm font-bold text-slate-700 uppercase tracking-wide">
          {header.split('.').slice(1).join('.').trim()}
        </h3>
      </div>

      {!selectedFile ? (
        <label
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={clsx(
            "relative flex flex-col items-center justify-center w-full h-[140px] border-2 border-dashed rounded-2xl cursor-pointer transition-all duration-300 ease-out group overflow-hidden bg-slate-50",
            isDragOver
              ? "border-indigo-500 bg-indigo-50 scale-[1.02]"
              : "border-slate-200 hover:border-indigo-400 hover:bg-slate-100"
          )}
        >
          <div className="flex flex-col items-center justify-center z-10 w-full h-full pt-2">
            <div className={clsx(
              "w-12 h-12 rounded-xl mb-3 flex items-center justify-center transition-colors duration-300",
              isDragOver ? "bg-indigo-100 text-indigo-600" : "bg-white text-slate-400 shadow-sm border border-slate-100 group-hover:text-indigo-500 group-hover:scale-110 group-hover:shadow-md transform transition-all"
            )}>
              {isDragOver ? <FileUp className="w-6 h-6 animate-bounce" /> : <Upload className="w-6 h-6" />}
            </div>
            <p className="text-sm text-slate-600 font-medium group-hover:text-indigo-900 transition-colors">
              Click to upload or drag & drop
            </p>
            <p className="text-xs text-slate-400 mt-1 font-medium">{label}</p>
          </div>
          <input type="file" className="hidden" accept={accept} onChange={handleFileInput} />
        </label>
      ) : (
        <div className="relative flex items-center p-4 w-full h-[100px] bg-white border border-slate-200 rounded-2xl shadow-sm hover:shadow-md transition-shadow group overflow-hidden">
          <div className="flex-shrink-0 p-3 bg-indigo-50 rounded-xl text-indigo-600 mr-4 border border-indigo-100">
            <FileText className="w-8 h-8" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-slate-800 truncate mb-0.5">
              {selectedFile.name}
            </p>
            <p className="text-xs text-slate-500 font-mono bg-slate-100 inline-block px-1.5 py-0.5 rounded">
              {(selectedFile.size / 1024).toFixed(1)} KB
            </p>
          </div>
          <button
            onClick={removeFile}
            className="p-2 ml-4 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-all z-20"
          >
            <X className="w-5 h-5" />
          </button>
          <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
            <CheckCircle className="w-4 h-4 text-green-500/50" />
          </div>

          <div className="absolute inset-y-0 left-0 w-1 bg-indigo-500" />
        </div>
      )}
    </div>
  );
}
