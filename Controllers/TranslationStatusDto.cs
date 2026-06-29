namespace Knowit.Umbraco.AiTranslate.Controllers;

public sealed record TranslationStatusDto(
    bool Configured,
    string RequiredProfileAlias,
    string? Message);
