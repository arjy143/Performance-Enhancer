#ifdef PERF_LENS_HAVE_LLVM

#include "translation_unit.hpp"
#include "util/logger.hpp"

#include <clang/ASTMatchers/ASTMatchFinder.h>
#include <clang/Frontend/ASTUnit.h>
#include <clang/Tooling/Tooling.h>
#include <clang/Tooling/JSONCompilationDatabase.h>
#include <llvm/Support/raw_ostream.h>

#include <filesystem>

namespace perf_lens::ast {

TranslationUnit::TranslationUnit(const std::string& file,
                                  clang::tooling::CompilationDatabase& db)
    : _file(file), _db(db) {}

bool TranslationUnit::_isStale() const {
    if (!_unit) return true;
    std::error_code ec;
    const auto mtime = std::filesystem::last_write_time(_file, ec);
    return ec || mtime != _mtime;
}

bool TranslationUnit::_parse() {
    const auto cmds = _db.getCompileCommands(_file);
    if (cmds.empty()) {
        Logger::instance().warn("TU: no compile command for " + _file);
        return false;
    }

    // Build argv from the first compile command (strip the output file part).
    std::vector<std::string> args = cmds.front().CommandLine;

    // ASTUnit::LoadFromCommandLine expects the full command including argv[0].
    std::vector<const char*> argv;
    argv.reserve(args.size());
    for (const auto& a : args) argv.push_back(a.c_str());

    auto diags = clang::CompilerInstance::createDiagnostics(
        new clang::DiagnosticOptions{});

    _unit = clang::ASTUnit::LoadFromCommandLine(
        argv.data(), argv.data() + argv.size(),
        std::make_shared<clang::PCHContainerOperations>(),
        diags,
        /*ResourceFilesPath=*/ "",
        /*OnlyLocalDecls=*/    false,
        /*CaptureDiagnostics=*/clang::CaptureDiagsKind::None,
        /*RemappedFiles=*/     {},
        /*RemappedFilesKeepOriginalName=*/ true,
        /*PrecompilePreamble=*/ 0,
        clang::TU_Complete,
        /*CacheCodeCompletionResults=*/ false,
        /*IncludeBriefCommentsInCodeCompletion=*/ false,
        /*AllowPCHWithCompilerErrors=*/ false,
        clang::SkipFunctionBodiesScope::None,
        /*SingleFileParse=*/   false,
        /*UserFilesAreVolatile=*/ true,
        /*ForSerialization=*/  false,
        /*RetainExcludedConditionalBlocks=*/ false,
        /*FailedParseDiagnosticClient=*/     nullptr);

    if (!_unit) {
        Logger::instance().warn("TU: failed to parse " + _file);
        return false;
    }

    std::error_code ec;
    _mtime = std::filesystem::last_write_time(_file, ec);
    Logger::instance().debug("TU: parsed " + _file);
    return true;
}

bool TranslationUnit::runMatchers(clang::ast_matchers::MatchFinder& finder) {
    if (_isStale() && !_parse()) return false;
    finder.matchAST(_unit->getASTContext());
    return true;
}

} // namespace perf_lens::ast

#endif // PERF_LENS_HAVE_LLVM
