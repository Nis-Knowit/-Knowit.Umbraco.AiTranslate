namespace Knowit.Umbraco.AiTranslate.Controllers;

public sealed record TranslateResult(
    int PropertiesTranslated,
    int PropertiesSkipped,
    int MediaCopied,
    IReadOnlyList<string> Errors,
    IReadOnlyList<string> CulturesWithContent);
