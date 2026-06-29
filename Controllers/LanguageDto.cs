namespace Knowit.Umbraco.AiTranslate.Controllers;

public sealed record LanguageDto(
    string IsoCode,
    string Name,
    bool IsDefault);
