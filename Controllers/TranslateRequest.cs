using System.ComponentModel.DataAnnotations;

namespace Knowit.Umbraco.AiTranslate.Controllers;

public sealed record TranslateRequest(
    [Required] Guid ContentId,
    [Required] string SourceCulture,
    [Required] string TargetCulture,
    bool Overwrite = false,
    bool CopyMedia = true,
    string? ProfileAlias = null,
    string? PromptAlias = null);
