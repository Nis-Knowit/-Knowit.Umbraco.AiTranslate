using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Asp.Versioning;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.AI;
using Microsoft.Extensions.Logging;
using Umbraco.AI.Core.Chat;
using Umbraco.Cms.Api.Management.Controllers;
using Umbraco.Cms.Api.Management.Routing;
using Umbraco.Cms.Core;
using Umbraco.Cms.Core.Models;
using Umbraco.Cms.Core.Services;
using Umbraco.Extensions;

namespace Knowit.Umbraco.AiTranslate.Controllers;

[ApiVersion("1.0")]
[VersionedApiBackOfficeRoute("translation")]
public sealed class TranslationController(
    IAIChatService chatService,
    IContentService contentService,
    IContentTypeService contentTypeService,
    ILanguageService languageService,
    ILogger<TranslationController> logger)
    : ManagementApiControllerBase
{
    private const string TranslationProfileAlias = "content-assistant";

    // Managed-prompt alias. Create a prompt with this alias in the Umbraco AI
    // Prompt UI to override the built-in instructions below; if none exists the
    // TranslationSystemPrompt default is used. Both aliases are overridable
    // per-request from the dashboard settings panel.
    private const string TranslationPromptAlias = "ai-translate";

    // Resolved per request (defaults unless the dashboard sends overrides).
    private string _profileAlias = TranslationProfileAlias;
    private string _promptAlias = TranslationPromptAlias;

    // Profile/prompt pairs already proven good this process — skips the
    // (tiny, paid) live probe on subsequent dashboard loads.
    private static readonly HashSet<string> _confirmed = new();

    private const string TranslationSystemPrompt =
        "You are a professional translator. Translate the user's text from the given source culture into the given target culture.\n\n" +
        "Rules:\n" +
        "- Cultures are ISO codes (e.g. en-US = English, da-DK = Danish, sv-SE = Swedish, de-DE = German, fr-FR = French, nb-NO = Norwegian Bokmål). Translate into the natural language matching the target code.\n" +
        "- If the source language already matches the target, return the content unchanged.\n" +
        "- Preserve all HTML tags, attributes, markdown, line breaks, and inline formatting exactly as-is.\n" +
        "- Do not translate brand names, product names, code snippets, URLs, or text inside <code> tags.\n" +
        "- Maintain the original tone (formal/informal) and reading level.\n" +
        "- Use natural, idiomatic phrasing — avoid literal word-for-word translation.\n" +
        "- Keep the translated length close to the original.\n" +
        "- Return only the translated text, ready to be saved directly into the field — no explanations, no quotes, no preamble.";

    [HttpGet("status")]
    [ProducesResponseType<TranslationStatusDto>(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetStatus(
        [FromQuery] string? profileAlias,
        [FromQuery] string? promptAlias,
        CancellationToken cancellationToken)
    {
        _profileAlias = string.IsNullOrWhiteSpace(profileAlias) ? TranslationProfileAlias : profileAlias;
        _promptAlias = string.IsNullOrWhiteSpace(promptAlias) ? TranslationPromptAlias : promptAlias;
        var key = $"{_profileAlias}|{_promptAlias}";

        lock (_confirmed)
        {
            if (_confirmed.Contains(key))
            {
                return Ok(new TranslationStatusDto(true, _profileAlias, null));
            }
        }

        try
        {
            // A minimal probe that exercises the profile, its connection, and
            // the provider credentials — the truest signal of "can we translate?".
            var messages = new List<ChatMessage>
            {
                new(ChatRole.System, "Reply with the single word: OK"),
                new(ChatRole.User, "ping"),
            };

            await CallChatRawAsync(messages, cancellationToken);

            lock (_confirmed)
            {
                _confirmed.Add(key);
            }

            return Ok(new TranslationStatusDto(true, _profileAlias, null));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "AI translation profile '{Profile}' / prompt '{Prompt}' is not usable.", _profileAlias, _promptAlias);
            return Ok(new TranslationStatusDto(false, _profileAlias, ex.Message));
        }
    }

    [HttpGet("languages")]
    [ProducesResponseType<IReadOnlyList<LanguageDto>>(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetLanguages()
    {
        var languages = await languageService.GetAllAsync();
        var dtos = languages
            .Select(l => new LanguageDto(l.IsoCode, l.CultureName ?? l.IsoCode, l.IsDefault))
            .ToList();
        return Ok(dtos);
    }

    [HttpGet("available-cultures")]
    [ProducesResponseType<IReadOnlyList<CultureOptionDto>>(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetAvailableCultures()
    {
        var existing = (await languageService.GetAllAsync())
            .Select(l => l.IsoCode)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var options = CultureInfo
            .GetCultures(CultureTypes.SpecificCultures)
            .Where(c => !string.IsNullOrWhiteSpace(c.Name) && !existing.Contains(c.Name))
            .Select(c => new CultureOptionDto(c.Name, c.EnglishName, c.NativeName))
            .OrderBy(o => o.EnglishName, StringComparer.OrdinalIgnoreCase)
            .ToList();

        return Ok(options);
    }

    [HttpPost("languages")]
    [ProducesResponseType<LanguageDto>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status400BadRequest)]
    public async Task<IActionResult> CreateLanguage([FromBody] CreateLanguageRequest request)
    {
        if (string.IsNullOrWhiteSpace(request.IsoCode))
        {
            return BadRequest("IsoCode is required.");
        }

        var existing = await languageService.GetAllAsync();
        if (existing.Any(l => string.Equals(l.IsoCode, request.IsoCode, StringComparison.OrdinalIgnoreCase)))
        {
            return BadRequest($"Language '{request.IsoCode}' already exists.");
        }

        string cultureName;
        try
        {
            cultureName = CultureInfo.GetCultureInfo(request.IsoCode).EnglishName;
        }
        catch (CultureNotFoundException)
        {
            return BadRequest($"'{request.IsoCode}' is not a valid culture.");
        }

        var language = new Language(request.IsoCode, cultureName)
        {
            IsDefault = false,
            IsMandatory = false,
            FallbackIsoCode = string.IsNullOrWhiteSpace(request.FallbackIsoCode) ? null : request.FallbackIsoCode,
        };

        var attempt = await languageService.CreateAsync(language, Constants.Security.SuperUserKey);
        if (!attempt.Success)
        {
            return BadRequest($"Could not create language '{request.IsoCode}': {attempt.Status}.");
        }

        var created = attempt.Result!;
        return Ok(new LanguageDto(created.IsoCode, created.CultureName ?? created.IsoCode, created.IsDefault));
    }

    [HttpGet("nodes")]
    [ProducesResponseType<IReadOnlyList<TranslationNodeDto>>(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetNodes()
    {
        var results = new List<TranslationNodeDto>();
        var contentTypeCache = new Dictionary<int, IContentType?>();

        var languages = await languageService.GetAllAsync();
        var allCultures = languages.Select(l => l.IsoCode).ToList();

        foreach (var root in contentService.GetRootContent())
        {
            Walk(root, results, contentTypeCache, allCultures);
        }

        return Ok(results);
    }

    private void Walk(
        IContent content,
        List<TranslationNodeDto> results,
        Dictionary<int, IContentType?> cache,
        IReadOnlyList<string> allCultures)
    {
        if (!cache.TryGetValue(content.ContentTypeId, out var contentType))
        {
            contentType = contentTypeService.Get(content.ContentTypeId);
            cache[content.ContentTypeId] = contentType;
        }

        if (contentType is not null)
        {
            var translatableProperties = contentType.CompositionPropertyTypes
                .Where(IsTranslatableEditor)
                .ToList();

            // Always emit a row — even structural nodes with no translatable
            // properties — so the frontend can render the full tree hierarchy
            // without orphaning translatable children of non-translatable parents.
            var culturesWithContent = translatableProperties.Count > 0
                ? allCultures
                    .Where(culture => translatableProperties.Any(p =>
                        !IsEmptyForEditor(content.GetValue(p.Alias, culture), p.PropertyEditorAlias)))
                    .ToList()
                : new List<string>();

            results.Add(new TranslationNodeDto(
                content.Key,
                content.Id,
                content.ParentId,
                content.Level,
                content.SortOrder,
                content.Name ?? "(unnamed)",
                contentType.Alias,
                translatableProperties.Count,
                culturesWithContent));
        }

        var children = contentService.GetPagedChildren(content.Id, 0, int.MaxValue, out _);
        foreach (var child in children)
        {
            Walk(child, results, cache, allCultures);
        }
    }

    [HttpPost("translate")]
    [ProducesResponseType<TranslateResult>(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status404NotFound)]
    public async Task<IActionResult> Translate(
        [FromBody] TranslateRequest request,
        CancellationToken cancellationToken)
    {
        if (string.Equals(request.SourceCulture, request.TargetCulture, StringComparison.OrdinalIgnoreCase))
        {
            return BadRequest("Source and target cultures must differ.");
        }

        _profileAlias = string.IsNullOrWhiteSpace(request.ProfileAlias) ? TranslationProfileAlias : request.ProfileAlias;
        _promptAlias = string.IsNullOrWhiteSpace(request.PromptAlias) ? TranslationPromptAlias : request.PromptAlias;

        var content = contentService.GetById(request.ContentId);
        if (content is null)
        {
            return NotFound();
        }

        var contentType = contentTypeService.Get(content.ContentTypeId);
        if (contentType is null)
        {
            return Problem("Content type could not be loaded.");
        }

        var translated = 0;
        var skipped = 0;
        var mediaCopied = 0;
        var errors = new List<string>();

        foreach (var prop in contentType.CompositionPropertyTypes.Where(p => p.VariesByCulture()))
        {
            var sourceValue = content.GetValue(prop.Alias, request.SourceCulture);
            if (IsEmptyForEditor(sourceValue, prop.PropertyEditorAlias))
            {
                continue;
            }

            var targetValue = content.GetValue(prop.Alias, request.TargetCulture);
            if (!request.Overwrite && !IsEmptyForEditor(targetValue, prop.PropertyEditorAlias))
            {
                skipped++;
                continue;
            }

            // Media references aren't translated — the same image belongs in
            // every language — so carry the value over verbatim when asked.
            if (IsMediaEditor(prop.PropertyEditorAlias))
            {
                if (request.CopyMedia)
                {
                    content.SetValue(prop.Alias, sourceValue, request.TargetCulture);
                    mediaCopied++;
                }
                continue;
            }

            try
            {
                var newValue = await TranslateValueAsync(
                    sourceValue,
                    prop.PropertyEditorAlias,
                    request.SourceCulture,
                    request.TargetCulture,
                    cancellationToken);

                if (newValue is null)
                {
                    errors.Add($"Property '{prop.Alias}' uses unsupported editor '{prop.PropertyEditorAlias}'.");
                    continue;
                }

                content.SetValue(prop.Alias, newValue, request.TargetCulture);
                translated++;
            }
            catch (Exception ex)
            {
                logger.LogError(ex, "Translation failed for property {Alias} on content {ContentId}", prop.Alias, content.Key);
                errors.Add($"Property '{prop.Alias}': {ex.Message}");
            }
        }

        if (string.IsNullOrWhiteSpace(content.GetCultureName(request.TargetCulture)))
        {
            var sourceName = content.GetCultureName(request.SourceCulture) ?? content.Name ?? "Untitled";
            content.SetCultureName(sourceName, request.TargetCulture);
        }

        if (translated > 0 || mediaCopied > 0)
        {
            contentService.Save(content);
        }

        var languages = await languageService.GetAllAsync();
        var translatableProperties = contentType.CompositionPropertyTypes
            .Where(IsTranslatableEditor)
            .ToList();

        var culturesWithContent = languages
            .Select(l => l.IsoCode)
            .Where(culture => translatableProperties.Any(p =>
                !IsEmptyForEditor(content.GetValue(p.Alias, culture), p.PropertyEditorAlias)))
            .ToList();

        return Ok(new TranslateResult(
            translated,
            skipped,
            mediaCopied,
            errors,
            culturesWithContent));
    }

    private async Task<object?> TranslateValueAsync(
        object sourceValue,
        string propertyEditorAlias,
        string sourceCulture,
        string targetCulture,
        CancellationToken cancellationToken)
    {
        switch (propertyEditorAlias)
        {
            case "Umbraco.TextBox":
            case "Umbraco.TextArea":
            case "Umbraco.MultilineTextstring":
            case "Umbraco.MarkdownEditor":
            {
                if (sourceValue is not string text || string.IsNullOrWhiteSpace(text))
                {
                    return null;
                }

                return await CallChatAsync(text, sourceCulture, targetCulture, cancellationToken);
            }

            case "Umbraco.RichText":
            {
                if (sourceValue is not string json || string.IsNullOrWhiteSpace(json))
                {
                    return null;
                }

                JsonNode? root;
                try
                {
                    root = JsonNode.Parse(json);
                }
                catch (JsonException)
                {
                    return await CallChatAsync(json, sourceCulture, targetCulture, cancellationToken);
                }

                if (root is JsonObject obj && obj["markup"] is JsonValue markupNode && markupNode.TryGetValue<string>(out var markup))
                {
                    if (string.IsNullOrWhiteSpace(markup))
                    {
                        return null;
                    }

                    var translatedMarkup = await CallChatAsync(markup, sourceCulture, targetCulture, cancellationToken);
                    obj["markup"] = translatedMarkup;
                    return obj.ToJsonString();
                }

                return await CallChatAsync(json, sourceCulture, targetCulture, cancellationToken);
            }

            case "Umbraco.MultiUrlPicker":
            {
                // Translate each link's display title only — keep the URL /
                // linked content and target exactly as they are.
                if (sourceValue is not string json || string.IsNullOrWhiteSpace(json))
                {
                    return null;
                }

                JsonNode? root;
                try
                {
                    root = JsonNode.Parse(json);
                }
                catch (JsonException)
                {
                    return null;
                }

                if (root is not JsonArray links)
                {
                    return null;
                }

                foreach (var link in links)
                {
                    if (link is JsonObject linkObj
                        && linkObj["name"] is JsonValue nameNode
                        && nameNode.TryGetValue<string>(out var name)
                        && !string.IsNullOrWhiteSpace(name))
                    {
                        linkObj["name"] = await CallChatAsync(name, sourceCulture, targetCulture, cancellationToken);
                    }
                }

                return links.ToJsonString();
            }

            default:
                return null;
        }
    }

    private static bool IsMediaEditor(string editorAlias) =>
        editorAlias is
            "Umbraco.MediaPicker3" or
            "Umbraco.MediaPicker" or
            "Umbraco.ImageCropper" or
            "Umbraco.UploadField";

    private async Task<string> CallChatAsync(
        string text,
        string sourceCulture,
        string targetCulture,
        CancellationToken cancellationToken)
    {
        var messages = new List<ChatMessage>
        {
            new(ChatRole.System, TranslationSystemPrompt),
            new(ChatRole.User, $"Source culture: {sourceCulture}\nTarget culture: {targetCulture}\n\nText:\n{text}"),
        };

        var response = await CallChatRawAsync(messages, cancellationToken);
        return response.Text ?? string.Empty;
    }

    private Task<ChatResponse> CallChatRawAsync(
        IList<ChatMessage> messages,
        CancellationToken cancellationToken)
    {
        // Non-static lambda so it can use the per-request profile/prompt aliases.
        var profile = _profileAlias;
        var prompt = _promptAlias;
        return chatService.GetChatResponseAsync(
            x => x.WithAlias(prompt).WithProfile(profile),
            messages,
            cancellationToken: cancellationToken);
    }

    private static bool IsTranslatableEditor(IPropertyType property) =>
        property.VariesByCulture() && property.PropertyEditorAlias is
            "Umbraco.TextBox" or
            "Umbraco.TextArea" or
            "Umbraco.MultilineTextstring" or
            "Umbraco.RichText" or
            "Umbraco.MarkdownEditor" or
            "Umbraco.MultiUrlPicker";

    private static bool IsEmptyForEditor(object? value, string editorAlias)
    {
        if (value is null)
        {
            return true;
        }

        if (value is not string s)
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(s))
        {
            return true;
        }

        if (editorAlias == "Umbraco.RichText")
        {
            try
            {
                if (JsonNode.Parse(s) is JsonObject obj
                    && obj["markup"] is JsonValue markupNode
                    && markupNode.TryGetValue<string>(out var markup))
                {
                    return string.IsNullOrWhiteSpace(StripTags(markup));
                }
            }
            catch (JsonException)
            {
                // Fall through to non-empty.
            }
        }

        return false;
    }

    private static string StripTags(string html) =>
        System.Text.RegularExpressions.Regex.Replace(html, "<[^>]*>", string.Empty).Trim();
}
